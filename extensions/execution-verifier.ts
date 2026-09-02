// ABOUTME: Deterministic verifier entry points bound to the current accepted contract.
// ABOUTME: Callers cannot supply assertions; those come from the approved plan or $PLAN.
// ABOUTME: Status is decided by assertion execution, not by an LLM.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerToolWithExecutor } from "./lib/tool-executor-registry.ts";
import { Type } from "@sinclair/typebox";
import { explicitDispatchHandler } from "./lib/dispatch-runtime.ts";
import {
	bumpVerifierAttempt,
	getExecutionContract,
	getVerifierReceipt,
	setVerifierReceipt,
} from "./lib/coordination-state.ts";
import { canComplete } from "./lib/verifier-runtime.ts";
import { runAcceptanceVerifier } from "./lib/isolated-verifier.ts";
import { emptyContract } from "./lib/execution-contract.ts";
import { runVerifierSubagent } from "./lib/verifier-subagent.ts";
import { buildWorkspaceManifest } from "./lib/workspace-manifest.ts";
import { DEFAULT_VERIFIER_ATTEMPTS } from "./lib/verification-policy.ts";
import { createOrchestrationRun } from "./lib/orchestration-run.ts";
import { coordinationState } from "./lib/coordination-state.ts";

const Params = Type.Object({
	objective: Type.Optional(Type.String({ description: "Optional review objective when no approved plan/spec contract exists" })),
	});

export default function (pi: ExtensionAPI) {
	pi.registerCommand("execution-status", {
		description: "Show the current acceptance contract and verifier receipt",
		handler: async (_args, ctx) => {
			const contract = getExecutionContract();
			const receipt = getVerifierReceipt();
			const cwd = ctx.cwd || process.cwd();
			if (!contract) { ctx.ui.notify("No acceptance contract is bound", "info"); return; }
			if (!receipt) {
				ctx.ui.notify(`UNVERIFIED · ${contract.objective} · ${contract.mandatory.length} assertions · ${contract.assertions.length} assertions/advisory`, "warning");
				return;
			}
			const manifest = buildWorkspaceManifest(cwd, contract.fingerprint);
			const current = canComplete(receipt, contract, manifest.hash);
			ctx.ui.notify(
				`${current ? receipt.status : "STALE"} · ${contract.objective} · attempt ${receipt.attempt}`,
				current ? "info" : "warning",
			);
		},
	});

	registerToolWithExecutor(pi, {
		name: "verify_execution",
		label: "Verify Execution",
		description: "Run the independent verifier subagent. With an approved contract it performs acceptance verification; without one it performs a code-change audit and never grants completion.",
		parameters: Params,
		execute: explicitDispatchHandler("subagent-tool", async (_id, _params, _signal, _update, ctx) => {
			let contract = getExecutionContract();
			const objective = ((_params as { objective?: string })?.objective || "Review the current code changes for correctness, tests, quality, security, and regressions.").trim();
			if (!contract) {
				contract = emptyContract(`# Review: ${objective}\n`, "plan");
				const audit = await runVerifierSubagent({
					cwd: ctx.cwd || process.cwd(),
					contract: { ...contract, objective },
					parentRunId: process.env.PI_AGENT_PI_RUN_ID,
					mode: coordinationState().mode,
					auditOnly: true,
				});
				const status = audit.report?.status || "BLOCKED";
				return {
					content: [{ type: "text", text: `Independent code-change audit: ${status} — ${audit.report?.summary || audit.error || "no valid verifier report"}. This review-only audit never grants completion.` }],
					details: { status, completionAllowed: false, audit: audit.report, runId: audit.runId },
				};
			}
			const cwd = ctx.cwd || process.cwd();
			const attempt = bumpVerifierAttempt();
			const orchestrationRun = createOrchestrationRun({
				context: ctx,
				parentRunId: process.env.PI_AGENT_PI_RUN_ID,
				actor: "verify_execution",
				mode: coordinationState().mode,
				budget: { maxSteps: 1 },
				workspaceCwd: cwd,
			});
			orchestrationRun.consumeStep();
			orchestrationRun.record("verification.started", { attempt, assertions: contract.mandatory.length });
			if (attempt > DEFAULT_VERIFIER_ATTEMPTS) {
				orchestrationRun.record("verification.completed", { status: "BLOCKED", attempt });
				orchestrationRun.finish("failed", { verificationStatus: "BLOCKED", attempt });
				return { content: [{ type: "text", text: `Verification blocked: maximum ${DEFAULT_VERIFIER_ATTEMPTS} attempts reached. Do not output done:true; report done:false with the exact blocker.` }], details: { status: "BLOCKED", completionAllowed: false, attempt } };
			}
			const verification = await runAcceptanceVerifier({
				cwd,
				contract,
				attempt,
				parentRunId: orchestrationRun.runId,
				mode: coordinationState().mode,
			});
			if (!verification.receipt) {
				orchestrationRun.record("verification.completed", { status: "BLOCKED", error: verification.error });
				orchestrationRun.finish("failed", { verificationStatus: "BLOCKED", error: verification.error });
				return { content: [{ type: "text", text: `${verification.error || "Verifier could not complete."} Do not output done:true.` }], details: { status: "BLOCKED", completionAllowed: false } };
			}
			setVerifierReceipt(verification.receipt);
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
				content: [{ type: "text", text: `Verifier: ${verification.receipt.status} — ${verification.receipt.results.filter(r => r.status !== "pass").map(r => r.raw).join("; ") || "all assertions passed"}` }],
				details: { status: verification.receipt.status, completionAllowed: verification.receipt.status === "PASS", receipt: verification.receipt },
			};
		}) as any,

	});
}
