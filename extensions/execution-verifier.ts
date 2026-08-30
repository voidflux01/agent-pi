// ABOUTME: Isolated verifier entry points bound to the current accepted contract.
// ABOUTME: Callers cannot supply objective or criteria; those come from the approved plan or $PLAN.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { join } from "node:path";
import { explicitDispatchHandler, currentDispatchAuthorization } from "./lib/dispatch-runtime.ts";
import {
	bumpVerifierAttempt,
	getExecutionContract,
	getVerifierReceipt,
	setVerifierReceipt,
} from "./lib/coordination-state.ts";
import { canComplete } from "./lib/verifier-runtime.ts";
import { runIsolatedVerifier } from "./lib/isolated-verifier.ts";
import { DEFAULT_VERIFIER_ATTEMPTS } from "./lib/verification-policy.ts";

const Params = Type.Object({});

export default function (pi: ExtensionAPI) {
	pi.registerCommand("execution-status", {
		description: "Show the current acceptance contract and verifier receipt",
		handler: async (_args, ctx) => {
			const contract = getExecutionContract();
			const receipt = getVerifierReceipt();
			if (!contract) { ctx.ui.notify("No acceptance contract is bound", "info"); return; }
			if (!receipt) { ctx.ui.notify(`UNVERIFIED · ${contract.objective} · ${contract.criteria.length} criteria`, "warning"); return; }
			const current = canComplete(receipt, contract);
			ctx.ui.notify(
				`${current ? receipt.status : "STALE"} · ${contract.objective} · attempt ${receipt.attempt}`,
				current ? "info" : "warning",
			);
		},
	});

	pi.registerTool({
		name: "verify_execution",
		label: "Verify Execution",
		description: "Run the isolated verifier against the approved acceptance checklist. Objective and criteria cannot be supplied by the caller.",
		parameters: Params,
		execute: explicitDispatchHandler("subagent-tool", async (_id, _params, _signal, _update, ctx) => {
			const contract = getExecutionContract();
			if (!contract) {
				return { content: [{ type: "text", text: "合同不全：没有已绑定的验收清单。先批准 plan 或完成管线 PLAN 相。" }], details: { status: "BLOCKED" } };
			}
			const attempt = bumpVerifierAttempt();
			if (attempt > DEFAULT_VERIFIER_ATTEMPTS) {
				return { content: [{ type: "text", text: `Verification blocked: maximum ${DEFAULT_VERIFIER_ATTEMPTS} attempts reached.` }], details: { status: "BLOCKED", attempt } };
			}
			const auth = currentDispatchAuthorization();
			if (!auth) {
				return { content: [{ type: "text", text: "Verification refused: explicit dispatch authorization is required." }], details: { status: "BLOCKED" } };
			}
			const verification = await runIsolatedVerifier({
				cwd: ctx.cwd || process.cwd(),
				contract,
				authorization: auth,
				attempt,
				launchDir: join(ctx.cwd || process.cwd(), ".pi", "agent-sessions"),
			});
			if (!verification.receipt) {
				return { content: [{ type: "text", text: verification.error || "Verifier could not complete." }], details: { status: "BLOCKED" } };
			}
			setVerifierReceipt(verification.receipt);
			return {
				content: [{ type: "text", text: `Verifier: ${verification.receipt.status}` }],
				details: { status: verification.receipt.status, receipt: verification.receipt },
			};
		}) as any,

	});
}
