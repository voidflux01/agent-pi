// ABOUTME: Shared bounded verifier loop used by engine-level completion points.
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AcceptanceContract } from "./execution-contract.ts";
import { checkRequiredEvalBinding } from "./eval-sets.ts";
import { runAcceptanceVerifier } from "./isolated-verifier.ts";
import { DEFAULT_VERIFIER_ATTEMPTS, verifierAction } from "./verification-policy.ts";
import { buildWorkspaceManifest } from "./workspace-manifest.ts";
import { canComplete, type VerifierReceipt } from "./verifier-runtime.ts";
import { bumpVerifierAttempt, getEvalGate, getVerifierReceipt, setEvalGate, setVerifierReceipt, verificationScope, getVerifierAttempt } from "./coordination-state.ts";
import { checkApproval, recordApproval, type ApprovalProposal } from "./workflow-approval-gate.ts";
import { upsertPersistedReport } from "./report-index.ts";
import { getRegisteredToolExecutors } from "./tool-executor-registry.ts";

export interface AutonomousCompletionOptions {
	contract: AcceptanceContract;
	cwd: string;
	mode: string;
	signal?: AbortSignal;
	parentRunId?: string;
	risk?: "low" | "medium" | "high";
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
	const scope = verificationScope(cwd, contract.fingerprint);
	return withVerificationLock(scope, async () => {
		if (contract.requiredEval) {
			const gate = checkRequiredEvalBinding(cwd, contract.requiredEval);
			setEvalGate(gate, scope);
			if (!gate.ok) return { allowed: false, status: "BLOCKED", reason: gate.reason, attempts: 0 };
		} else setEvalGate(undefined, scope);
		const evalGate = getEvalGate(scope);
		const manifest = buildWorkspaceManifest(cwd, contract.fingerprint);
		const stored = getVerifierReceipt(scope);
		const existing = stored?.contractFingerprint === contract.fingerprint ? stored : undefined;
		if (canComplete(existing, contract, manifest.hash, evalGate)) return { allowed: true, status: "PASS", receipt: existing, attempts: 0 };
		let attempts = getVerifierAttempt(scope);
		let previousReport = existing?.verifier?.report;
		while (attempts < DEFAULT_VERIFIER_ATTEMPTS) {
			if (input.signal?.aborted) return { allowed: false, status: "BLOCKED", reason: "verification cancelled", attempts };
			attempts = bumpVerifierAttempt(scope);
			const result = await runAcceptanceVerifier({ cwd, contract, attempt: attempts, mode: input.mode, parentRunId: input.parentRunId, signal: input.signal, previousReport });
			if (!result.receipt) return { allowed: false, status: "BLOCKED", reason: result.error || "verifier failed to return receipt", attempts };
			setVerifierReceipt(result.receipt, scope);
			previousReport = result.receipt.verifier?.report;
			try { upsertPersistedReport({ category: "eval", title: `Verifier attempt ${attempts}: ${result.receipt.status}`, summary: result.receipt.verifier?.summary || result.receipt.status, metadata: { mode: input.mode, contract: contract.fingerprint, scope } }); } catch { }
			const action = verifierAction(result.receipt.status, attempts, DEFAULT_VERIFIER_ATTEMPTS, result.receipt.results.some((r) => r.status !== "pass"));
			if (action === "complete") return { allowed: true, status: "PASS", receipt: result.receipt, attempts };
			if (action === "retry") {
				if (!input.dispatchRepair) return { allowed: false, status: "FAIL", receipt: result.receipt, reason: "verifier found actionable failures but no repair dispatcher is available", attempts };
				const feedback = result.receipt.verifier?.summary || result.receipt.results.filter((r) => r.status !== "pass").map((r) => `${r.raw}: ${r.note || r.status}`).join("; ") || "verifier reported failure";
				if (!await input.dispatchRepair(`${contract.objective}\n\nVerifier feedback:\n${feedback}\n\nFix workspace until contract passes, then report RESULT status.`, input.signal)) return { allowed: false, status: "FAIL", receipt: result.receipt, reason: "repair worker failed", attempts };
				continue;
			}
			const proposal: ApprovalProposal = { title: contract.objective, action: "completion", scope: contract.objective, artifacts: [] };
			if (input.risk === "high") {
				const approval = checkApproval(cwd, proposal);
				const approved = approval.approved || await input.onHumanDecision?.(proposal) === true;
				if (approved) { recordApproval(cwd, proposal, true); continue; }
			}
			return { allowed: false, status: action === "escalate" ? "ESCALATE" : result.receipt.status, receipt: result.receipt, reason: "human approval required", attempts };
		}
		return { allowed: false, status: "BLOCKED", reason: "maximum attempts reached", attempts };
	});
}
