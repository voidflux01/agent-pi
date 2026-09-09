// ABOUTME: Shared bounded verifier loop used by engine-level completion points.
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AcceptanceContract } from "./execution-contract.ts";
import { checkRequiredEvalBinding } from "./eval-sets.ts";
import { runAcceptanceVerifier } from "./isolated-verifier.ts";
import { DEFAULT_VERIFIER_ATTEMPTS } from "./verification-policy.ts";
import { decideIteration, loadIteration, recordIteration, type IterationDecision, type IterationFailure, type IterationObservation } from "./iteration-controller.ts";
import { buildWorkspaceManifest, type WorkspaceManifest } from "./workspace-manifest.ts";
import { canComplete, type VerifierReceipt } from "./verifier-runtime.ts";
import { bumpVerifierAttempt, getEvalGate, getVerifierReceipt, setEvalGate, setVerifierReceipt, verificationScope, getVerifierAttempt } from "./coordination-state.ts";
import { checkApproval, recordApproval, type ApprovalProposal } from "./workflow-approval-gate.ts";
import { upsertPersistedReport } from "./report-index.ts";
import { getRegisteredToolExecutors } from "./tool-executor-registry.ts";
import { loadLatestWorkflowRun, updateWorkflowRun, type WorkflowRunStatus } from "./workflow-run.ts";

export interface AutonomousCompletionOptions {
	contract: AcceptanceContract;
	cwd: string;
	mode: string;
	signal?: AbortSignal;
	parentRunId?: string;
	runId?: string;
	risk?: "low" | "medium" | "high";
	failure?: IterationFailure;
	onHumanDecision?: (proposal: ApprovalProposal) => Promise<boolean>;
	dispatchRepair?: (task: string, signal?: AbortSignal) => Promise<boolean>;
}

/** Shared builder repair dispatcher: use canonical joined subagent_create only. */
export function builderRepairDispatcher(ctx: ExtensionContext, agentName = "builder", repairScope = "autonomous-repair"): (task: string, signal?: AbortSignal) => Promise<boolean> {
	return async (task, signal) => {
		if (signal?.aborted) return false;
		const executor = getRegisteredToolExecutors().subagent_create;
		if (!executor) return false;
		let response: unknown;
		try {
			response = await executor("autonomous-repair", { name: agentName, task, join: true, scope: repairScope }, signal, undefined, ctx);
		} catch {
			return false;
		}
		if (!response || typeof response !== "object") return false;
		const details = "details" in response && response.details && typeof response.details === "object" ? response.details as Record<string, unknown> : undefined;
		if (details?.error === true || signal?.aborted) return false;
		const status = typeof details?.status === "string" ? details.status.toLowerCase() : "";
		return status === "done" || status === "succeeded";
	};
}

export interface AutonomousCompletionResult {
	allowed: boolean;
	status: "PASS" | "FAIL" | "BLOCKED" | "ESCALATE";
	receipt?: VerifierReceipt;
	reason?: string;
	attempts: number;
	iteration?: IterationDecision;
	runId?: string;
}

function workflowRunStatus(iteration: IterationDecision): WorkflowRunStatus {
	if (iteration.action === "COMPLETE") return "COMPLETE";
	if (iteration.action === "BLOCKED") return "BLOCKED";
	if (iteration.requiresApproval || iteration.action === "REPLAN" || iteration.action === "ESCALATE") return "WAITING_APPROVAL";
	return "RUNNING";
}

function workflowNextAction(iteration: IterationDecision): string {
	if (iteration.action === "COMPLETE") return "Verifier PASS; call show_report";
	const handoff = iteration.action === "REPLAN" ? ` Switch to ${iteration.nextMode || "PLAN"}, obtain fresh approval, then resume.` : "";
	return `${iteration.reason}${handoff}`;
}

function syncWorkflowRun(input: AutonomousCompletionOptions, receipt: VerifierReceipt, iteration: IterationDecision, runId?: string): void {
	const current = loadLatestWorkflowRun(input.cwd);
	const linkedRunId = runId || input.runId || current?.run_id;
	if (!current || !linkedRunId || current.run_id !== linkedRunId) return;
	try {
		updateWorkflowRun(input.cwd, {
			run_id: linkedRunId,
			contract_fingerprint: receipt.contractFingerprint,
			mode: input.mode,
			status: workflowRunStatus(iteration),
			next_action: workflowNextAction(iteration),
		});
	} catch { /* Status is observational; verifier authority remains unchanged. */ }
}

function classifyFailure(receipt: VerifierReceipt, input: AutonomousCompletionOptions): IterationFailure | undefined {
	if (input.failure) return input.failure;
	if (receipt.status !== "FAIL") return undefined;
	if (receipt.results.some(result => result.status === "blocked")) return "evidence";
	return "implementation";
}

function observeReceipt(receipt: VerifierReceipt, input: AutonomousCompletionOptions, before?: WorkspaceManifest): IterationObservation {
	const summary = receipt.verifier?.summary || receipt.results.filter(result => result.status !== "pass").map(result => `${result.raw}: ${result.note || result.status}`).join("; ");
	const after = buildWorkspaceManifest(input.cwd, input.contract.fingerprint);
	const beforePaths = new Map((before?.files ?? []).map(file => [file.path, file.hash]));
	const changedFiles = after.files.filter(file => beforePaths.get(file.path) !== file.hash).map(file => file.path);

	return {
		runId: receipt.verifier?.runId || `verifier-${receipt.attempt}`,
		parentRunId: input.parentRunId,
		mode: input.mode,
		contractFingerprint: input.contract.fingerprint,
		status: receipt.status,
		attempt: receipt.attempt,
		failure: classifyFailure(receipt, input),
		failureSignature: summary || undefined,
		evidenceRefs: receipt.results.map(result => result.raw).slice(0, 20),
		changedFiles,
		createdAt: receipt.createdAt,
	};
}

function persistObservation(observation: IterationObservation, cwd: string): boolean {
	try { recordIteration(cwd, observation); return true; } catch { return false; }
}

const verificationLocks = new Map<string, Promise<void>>();

async function withVerificationLock<T>(scope: string, run: () => Promise<T>): Promise<T> {
	const previous = verificationLocks.get(scope) || Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => { release = resolve; });
	const tail = previous.then(() => current);
	verificationLocks.set(scope, tail);
	await previous;
	try {
		return await run();
	} finally {
		release();
		if (verificationLocks.get(scope) === tail) verificationLocks.delete(scope);
	}
}

export async function runAutonomousCompletion(input: AutonomousCompletionOptions): Promise<AutonomousCompletionResult> {
	const { contract, cwd } = input;
	const runId = input.runId || loadLatestWorkflowRun(cwd)?.run_id;
	const withRunId = (value: AutonomousCompletionResult): AutonomousCompletionResult => runId ? { ...value, runId } : value;
	const scope = verificationScope(cwd, contract.fingerprint);
	return withVerificationLock(scope, async () => {
		if (contract.requiredEval) {
			const gate = checkRequiredEvalBinding(cwd, contract.requiredEval);
			setEvalGate(gate, scope);
			if (!gate.ok) return withRunId({ allowed: false, status: "BLOCKED", reason: gate.reason, attempts: 0 });
		} else setEvalGate(undefined, scope);
		const evalGate = getEvalGate(scope);
		const manifest = buildWorkspaceManifest(cwd, contract.fingerprint);
		const stored = getVerifierReceipt(scope);
		const existing = stored?.contractFingerprint === contract.fingerprint ? stored : undefined;
		if (canComplete(existing, contract, manifest.hash, evalGate) && existing) {
			const observation = observeReceipt(existing, input, manifest);
			const iteration = decideIteration({ observation, previous: loadIteration(cwd, contract.fingerprint), maxIterations: DEFAULT_VERIFIER_ATTEMPTS, repairAvailable: false, risk: input.risk });
			syncWorkflowRun(input, existing, iteration, runId);
			if (!persistObservation(observation, cwd)) return withRunId({ allowed: false, status: "BLOCKED", reason: "iteration history unavailable", attempts: 0, receipt: existing, iteration });
			return withRunId(iteration.action === "COMPLETE" ? { allowed: true, status: "PASS", receipt: existing, attempts: 0, iteration } : { allowed: false, status: "BLOCKED", reason: iteration.reason, receipt: existing, attempts: 0, iteration });
		}
		let attempts = getVerifierAttempt(scope);
		let previousReport = existing?.verifier?.report;
		while (attempts < DEFAULT_VERIFIER_ATTEMPTS) {
			if (input.signal?.aborted) return withRunId({ allowed: false, status: "BLOCKED", reason: "verification cancelled", attempts });
			attempts = bumpVerifierAttempt(scope);
			const result = await runAcceptanceVerifier({ cwd, contract, attempt: attempts, mode: input.mode, parentRunId: input.parentRunId, signal: input.signal, previousReport });
			if (!result.receipt) return withRunId({ allowed: false, status: "BLOCKED", reason: result.error || "verifier failed to return receipt", attempts });
			setVerifierReceipt(result.receipt, scope);
			previousReport = result.receipt.verifier?.report;
			try { upsertPersistedReport({ category: "eval", title: `Verifier attempt ${attempts}: ${result.receipt.status}`, summary: result.receipt.verifier?.summary || result.receipt.status, metadata: { mode: input.mode, contract: contract.fingerprint, scope, ...(runId ? { runId } : {}) } }); } catch { }
			const observation = observeReceipt(result.receipt, input, manifest);
			const previous = loadIteration(cwd, contract.fingerprint);
			const iteration = decideIteration({ observation, previous, maxIterations: DEFAULT_VERIFIER_ATTEMPTS, repairAvailable: !!input.dispatchRepair, risk: input.risk });
			syncWorkflowRun(input, result.receipt, iteration, runId);
			if (!persistObservation(observation, cwd)) return withRunId({ allowed: false, status: "BLOCKED", receipt: result.receipt, reason: "iteration history unavailable", attempts, iteration });
			if (iteration.action === "COMPLETE") return withRunId({ allowed: true, status: "PASS", receipt: result.receipt, attempts, iteration });
			if (iteration.action === "REPAIR") {
				const feedback = result.receipt.verifier?.summary || result.receipt.results.filter((r) => r.status !== "pass").map((r) => `${r.raw}: ${r.note || r.status}`).join("; ") || "verifier reported failure";
				if (!await input.dispatchRepair!(`${contract.objective}\n\nVerifier feedback:\n${feedback}\n\nFix workspace until contract passes, then report RESULT status.`, input.signal)) return withRunId({ allowed: false, status: "FAIL", receipt: result.receipt, reason: "repair worker failed", attempts, iteration });
				continue;
			}
			return withRunId({ allowed: false, status: iteration.action === "ESCALATE" ? "ESCALATE" : "BLOCKED", receipt: result.receipt, reason: iteration.reason, attempts, iteration });
		}
		return withRunId({ allowed: false, status: "BLOCKED", reason: "maximum attempts reached", attempts });
	});
}
