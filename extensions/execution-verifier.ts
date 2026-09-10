// ABOUTME: Deterministic verifier entry points bound to the current accepted contract.
// ABOUTME: Callers cannot supply assertions; those come from the approved plan or $PLAN.
// ABOUTME: Status is decided by assertion execution, not by an LLM.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerToolWithExecutor } from "./lib/tool-executor-registry.ts";
import { Type } from "@sinclair/typebox";
import { explicitDispatchHandler } from "./lib/dispatch-runtime.ts";
import {
	bumpVerifierAttempt,
	getVerifierAttempt,
	getExecutionContract,
	getVerifierReceipt,
	setExecutionContract,
	setVerifierReceipt,
	verificationScope,
	getEvalGate,
} from "./lib/coordination-state.ts";
import { canComplete } from "./lib/verifier-runtime.ts";
import { runAcceptanceVerifier } from "./lib/isolated-verifier.ts";
import { bindAcceptanceContract } from "./lib/execution-contract.ts";
import { buildWorkspaceManifest } from "./lib/workspace-manifest.ts";
import { DEFAULT_VERIFIER_ATTEMPTS } from "./lib/verification-policy.ts";
import { createOrchestrationRun } from "./lib/orchestration-run.ts";
import { coordinationState } from "./lib/coordination-state.ts";
import { setEvalGate } from "./lib/coordination-state.ts";
import { workflowDirection } from "./lib/workflow-direction.ts";
import { checkRequiredEvalBinding } from "./lib/eval-sets.ts";
import { getWorkflowRunLink } from "./lib/coordination-state.ts";
import { markWorkflowRunBlocked, updateWorkflowRun } from "./lib/workflow-run.ts";
import type { VerifierSubagentReport } from "./lib/verifier-subagent.ts";

function formatVerifierReport(report: VerifierSubagentReport): string {
	const list = (items: string[]) => items.length ? items.map(item => `- ${item}`).join("\n") : "- none";
	const files = (items?: string[]) => items?.length ? `\nfiles:\n${list(items)}` : "";
	const requirements = report.requirements.map((item, index) => `### REQ-${String(index + 1).padStart(3, "0")}\nstatus: ${item.status}\nrequirement: ${item.requirement}\nevidence: ${item.evidence}${files(item.files)}`).join("\n\n");
	const reviews = report.review.findings.map((item, index) => `### REV-${String(index + 1).padStart(3, "0")}\nseverity: ${item.severity || "LOW"}\ncategory: ${item.category || "maintainability"}\ntitle: ${item.title || "review finding"}\nlocation: ${item.location || "unknown"}\nevidence: ${item.evidence || "none"}\nrecommendation: ${item.recommendation || "none"}`).join("\n\n");
	const tests = report.behavior.tests || { discovered: 0, executed: 0, failed: 0, skipped: 0 };
	return [
		"## RESULT",
		"role: verifier",
		"done: true",
		`status: ${report.status}`,
		`summary: ${report.summary}`,
		"findings:", list([...report.contract.findings, ...report.behavior.findings, ...report.quality.findings, ...report.security.findings]),
		"files:", list(report.requirements.flatMap(item => item.files || [])),
		"verification:", list([`verifier report: ${report.status}`]),
		"key_errors:", list(report.hard_blockers),
		"remaining:", list(report.warnings),
		"",
		"## Requirements",
		requirements,
		"",
		"## Contract",
		`status: ${report.contract.status}`,
		"findings:", list(report.contract.findings),
		"",
		"## Review",
		`status: ${report.review.status}`,
		reviews || "(no review findings)",
		"",
		"## Behavior",
		`status: ${report.behavior.status}`,
		`tests_discovered: ${tests.discovered}`,
		`tests_executed: ${tests.executed}`,
		`tests_failed: ${tests.failed}`,
		`tests_skipped: ${tests.skipped}`,
		"findings:", list(report.behavior.findings),
		"",
		"## Quality",
		`status: ${report.quality.status}`,
		"findings:", list(report.quality.findings),
		"",
		"## Security",
		`status: ${report.security.status}`,
		"findings:", list(report.security.findings),
		"",
		"## Hard Blockers",
		list(report.hard_blockers),
		"",
		"## Warnings",
		list(report.warnings),
		"## END",
	].join("\n");
}

const Params = Type.Object({
	contract: Type.Optional(Type.String({ description: "The exact user-confirmed acceptance contract in Markdown, including an Objective and any optional context or explicit eval binding" })),
	objective: Type.Optional(Type.String({ description: "Optional short objective when contract is supplied separately" })),
});

function syncVerifierWorkflowRun(cwd: string, status: "PASS" | "FAIL" | "BLOCKED", receipt?: { contractFingerprint: string; results: Array<{ status: string }> }): void {
	const runId = getWorkflowRunLink(cwd)?.runId;
	if (!runId) return;
	try {
		if (status === "BLOCKED" || receipt?.results.some((result) => result.status === "blocked")) {
			markWorkflowRunBlocked(cwd, runId, "Verification blocked; resolve verifier prerequisites and retry");
			return;
		}
		updateWorkflowRun(cwd, {
			run_id: runId,
			contract_fingerprint: receipt?.contractFingerprint,
			status: "RUNNING",
			next_action: status === "PASS" ? "Verifier PASS; call show_report" : "Verifier FAIL; repair workspace and retry verification",
		});
	} catch { }
}

export default function(pi: ExtensionAPI) {
	pi.registerCommand("execution-status", {
		description: "Show the current acceptance contract and verifier receipt",
		handler: async (_args, ctx) => {
			const contract = getExecutionContract();
			const cwd = ctx.cwd || process.cwd();
			if (!contract) { ctx.ui.notify("No acceptance contract is bound", "info"); return; }
			const scope = verificationScope(cwd, contract.fingerprint);
			const receipt = getVerifierReceipt(scope);
			if (!receipt) {
				ctx.ui.notify(`UNVERIFIED · ${contract.objective} · Objective review pending · ${contract.assertions.length} context items`, "warning");
				return;
			}
			const manifest = buildWorkspaceManifest(cwd, contract.fingerprint);
			const current = canComplete(receipt, contract, manifest.hash, getEvalGate(scope));
			ctx.ui.notify(
				`${current ? receipt.status : "STALE"} · ${contract.objective} · attempt ${receipt.attempt}`,
				current ? "info" : "warning",
			);
		},
	});

	registerToolWithExecutor(pi, {
		name: "verify_execution",
		label: "Verify Execution",
		description: "Run the independent verifier subagent against the exact user-confirmed acceptance contract. The contract may be supplied directly; show_plan/show_spec are optional presentation surfaces. Without a contract, verification is blocked and no subagent is started.",
		parameters: Params,
		execute: explicitDispatchHandler("subagent-tool", async (_id, _params, signal, _update, ctx) => {
			let contract = getExecutionContract();
			const suppliedContract = ((_params as { contract?: string })?.contract || "").trim();
			if (suppliedContract) {
				const bound = bindAcceptanceContract(suppliedContract, "plan");
				if ("error" in bound) {
					syncVerifierWorkflowRun(ctx.cwd || process.cwd(), "BLOCKED");
					return {
						content: [{ type: "text", text: "Verification blocked: the supplied acceptance contract is incomplete. It must state a non-empty Objective. Ask the user to confirm the corrected contract before retrying." }],
						details: { status: "BLOCKED", completionAllowed: false, reason: "incomplete supplied acceptance contract" },
					};
				}
				setExecutionContract(bound);
				contract = bound;
			}
			if (!contract) {
				syncVerifierWorkflowRun(ctx.cwd || process.cwd(), "BLOCKED");
				return {
					content: [{ type: "text", text: "Verification blocked: no user-confirmed acceptance contract was supplied or bound. The parent agent must create the contract covering scope and acceptance conditions, get user confirmation, and pass that exact contract to verify_execution. show_plan/show_spec are optional; do not output done:true." }],
					details: { status: "BLOCKED", completionAllowed: false, reason: "no approved acceptance contract" },
				};
			}
			const cwd = ctx.cwd || process.cwd();
			const scope = verificationScope(cwd, contract.fingerprint);
			// A contract-bound eval set is a mandatory acceptance item: a missing, stale
			// or failed report blocks verification itself, so no receipt can exist.
			if (contract.requiredEval) {
				const gate = checkRequiredEvalBinding(cwd, contract.requiredEval);
				setEvalGate(gate, scope);
				if (!gate.ok) {
					syncVerifierWorkflowRun(cwd, "BLOCKED");
					return { content: [{ type: "text", text: `Verification blocked: ${gate.reason} Do not output done:true.` }], details: { status: "BLOCKED", completionAllowed: false, reason: "required eval gate not satisfied" } };
				}
			} else setEvalGate(undefined, scope);
			// A PASS receipt is already bound to both this contract and the exact
			// workspace manifest. Reuse it instead of launching another verifier
			// session/Herdr pane when the parent repeats the same tool call.
			const previousReceipt = getVerifierReceipt(scope);
			const currentManifest = buildWorkspaceManifest(cwd, contract.fingerprint);
			if (canComplete(previousReceipt, contract, currentManifest.hash, contract.requiredEval ? { ok: true } : undefined)) {
				syncVerifierWorkflowRun(cwd, "PASS", previousReceipt);
				const summary = previousReceipt?.verifier?.summary || "existing PASS receipt is still current";
				return {
					content: [{ type: "text", text: previousReceipt?.verifier?.report ? formatVerifierReport(previousReceipt.verifier.report) : `Verifier: PASS — reused current receipt; ${summary}` }],
					details: { status: "PASS", completionAllowed: true, receipt: previousReceipt, reused: true, reason: "same contract and unchanged workspace" },
				};
			}
			if (previousReceipt && previousReceipt.status !== "PASS" && previousReceipt.workspaceManifestHash === currentManifest.hash) {
				syncVerifierWorkflowRun(cwd, "BLOCKED");
				return { content: [{ type: "text", text: "Verification blocked: previous findings remain and the workspace is unchanged since that audit, so re-running would only repeat it. Two ways forward: (1) repair the findings in the workspace, then retry; (2) if a finding is not repairable by code — an unverifiable or ambiguous acceptance criterion — go back to the user, correct the acceptance contract, and re-run verification against the corrected contract (a changed contract starts a fresh attempt budget). Do not output done:true." }], details: { status: "BLOCKED", completionAllowed: false, reason: "workspace unchanged since previous non-PASS verification", receipt: previousReceipt } };
			}
			const previousAttempt = getVerifierAttempt(scope);
			if (previousAttempt >= DEFAULT_VERIFIER_ATTEMPTS) {
				syncVerifierWorkflowRun(cwd, "BLOCKED");
				return { content: [{ type: "text", text: `Verification blocked: maximum ${DEFAULT_VERIFIER_ATTEMPTS} attempts reached. Do not output done:true; report done:false with the exact blocker.` }], details: { status: "BLOCKED", completionAllowed: false, attempt: previousAttempt } };
			}
			const attempt = bumpVerifierAttempt(scope);
			// Re-verification rounds against the same contract get a narrowed delta
			// prompt built from the prior receipt — fresh session, focused audit.
			const previousReport = previousReceipt?.verifier?.report
				&& previousReceipt.contractFingerprint === contract.fingerprint
				? previousReceipt.verifier.report
				: undefined;
			const orchestrationRun = createOrchestrationRun({
				context: ctx,
				parentRunId: process.env.PI_AGENT_PI_RUN_ID,
				actor: "verify_execution",
				mode: coordinationState().mode,
				budget: { maxSteps: 1 },
				workspaceCwd: cwd,
			});
			orchestrationRun.consumeStep();
			orchestrationRun.record("verification.started", { attempt, objective: contract.objective });
			const verification = await runAcceptanceVerifier({
				cwd,
				contract,
				contractText: suppliedContract || undefined,
				attempt,
				parentRunId: orchestrationRun.runId,
				mode: coordinationState().mode,
				previousReport,
				signal,
			});
			if (!verification.receipt) {
				syncVerifierWorkflowRun(cwd, "BLOCKED");
				orchestrationRun.record("verification.completed", { status: "BLOCKED", error: verification.error });
				orchestrationRun.finish("failed", { verificationStatus: "BLOCKED", error: verification.error });
				return { content: [{ type: "text", text: `${verification.error || "Verifier could not complete."} Do not output done:true.` }], details: { status: "BLOCKED", completionAllowed: false } };
			}
			setVerifierReceipt(verification.receipt, scope);
			syncVerifierWorkflowRun(cwd, verification.receipt.status, verification.receipt);
			orchestrationRun.record("verification.completed", {
				status: verification.receipt.status,
				passed: verification.receipt.results.filter(result => result.status === "pass").length,
				failed: verification.receipt.results.filter(result => result.status !== "pass").length,
			});
			orchestrationRun.finish(verification.receipt.status === "PASS" ? "succeeded" : "failed", {
				verificationStatus: verification.receipt.status,
				attempt,
			});
			return {
				content: [{ type: "text", text: verification.receipt.verifier?.report ? formatVerifierReport(verification.receipt.verifier.report) : `Verifier: ${verification.receipt.status} — ${verification.receipt.verifier?.summary || "no verifier summary"}` }],
				details: {
					status: verification.receipt.status, completionAllowed: verification.receipt.status === "PASS", receipt: verification.receipt,
					nextAction: workflowDirection({ status: verification.receipt.status, attempt })
				},
			};
		}) as any,

	});
}
