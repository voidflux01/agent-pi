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

const Params = Type.Object({
	contract: Type.Optional(Type.String({ description: "The exact user-confirmed acceptance contract in Markdown, including an Objective and any optional context or explicit eval binding" })),
	objective: Type.Optional(Type.String({ description: "Optional short objective when contract is supplied separately" })),
});

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
					return {
						content: [{ type: "text", text: "Verification blocked: the supplied acceptance contract is incomplete. It must state a non-empty Objective. Ask the user to confirm the corrected contract before retrying." }],
						details: { status: "BLOCKED", completionAllowed: false, reason: "incomplete supplied acceptance contract" },
					};
				}
				setExecutionContract(bound);
				contract = bound;
			}
			if (!contract) {
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
					return { content: [{ type: "text", text: `Verification blocked: ${gate.reason} Do not output done:true.` }], details: { status: "BLOCKED", completionAllowed: false, reason: "required eval gate not satisfied" } };
				}
			} else setEvalGate(undefined, scope);
			// A PASS receipt is already bound to both this contract and the exact
			// workspace manifest. Reuse it instead of launching another verifier
			// session/Herdr pane when the parent repeats the same tool call.
			const previousReceipt = getVerifierReceipt(scope);
			const currentManifest = buildWorkspaceManifest(cwd, contract.fingerprint);
			if (canComplete(previousReceipt, contract, currentManifest.hash, contract.requiredEval ? { ok: true } : undefined)) {
				const summary = previousReceipt?.verifier?.summary || "existing PASS receipt is still current";
				return {
					content: [{ type: "text", text: `Verifier: PASS — reused current receipt; ${summary}` }],
					details: { status: "PASS", completionAllowed: true, receipt: previousReceipt, reused: true, reason: "same contract and unchanged workspace" },
				};
			}
			const previousAttempt = getVerifierAttempt(scope);
			if (previousAttempt >= DEFAULT_VERIFIER_ATTEMPTS) {
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
				orchestrationRun.record("verification.completed", { status: "BLOCKED", error: verification.error });
				orchestrationRun.finish("failed", { verificationStatus: "BLOCKED", error: verification.error });
				return { content: [{ type: "text", text: `${verification.error || "Verifier could not complete."} Do not output done:true.` }], details: { status: "BLOCKED", completionAllowed: false } };
			}
			setVerifierReceipt(verification.receipt, scope);
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
				content: [{ type: "text", text: `Verifier: ${verification.receipt.status} — ${verification.receipt.results.filter(r => r.status !== "pass").map(r => `${r.raw}${r.note ? ` (${r.note})` : ""}`).join("; ") || "all assertions passed"}` }],
				details: {
					status: verification.receipt.status, completionAllowed: verification.receipt.status === "PASS", receipt: verification.receipt,
					nextAction: workflowDirection({ status: verification.receipt.status, attempt })
				},
			};
		}) as any,

	});
}
