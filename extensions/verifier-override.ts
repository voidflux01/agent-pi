// ABOUTME: verifier_override — records an explicit user-approved completion
// ABOUTME: override when the isolated verifier's context made it misjudge a FAIL/BLOCK.
// ABOUTME: Only a recorded, TTL-bound user approval unlocks the completion gates; the
// ABOUTME: parent asserting alone never flips them. Grants are bound to the contract
// ABOUTME: fingerprint and surfaced in /workflow approvals and the completion report.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerToolWithExecutor } from "./lib/tool-executor-registry.ts";
import { Type } from "@sinclair/typebox";
import { explicitDispatchHandler } from "./lib/dispatch-runtime.ts";
import {
	getExecutionContract,
	setExecutionContract,
	getVerifierReceipt,
	setEvalGate,
	verificationScope,
} from "./lib/coordination-state.ts";
import { canComplete } from "./lib/verifier-runtime.ts";
import { bindAcceptanceContract } from "./lib/execution-contract.ts";
import { buildWorkspaceManifest } from "./lib/workspace-manifest.ts";
import { checkRequiredEvalBinding } from "./lib/eval-sets.ts";
import { grantCompletionOverride } from "./lib/completion-override.ts";

const Params = Type.Object({
	reason: Type.String({
		minLength: 1,
		description: "Why the user approved completion despite the verifier's non-PASS verdict. Name the disputed finding and the counter-evidence.",
	}),
	contract: Type.Optional(Type.String({
		description: "Optional acceptance contract text. Defaults to the currently bound execution contract.",
	})),
});

export default function(pi: ExtensionAPI) {
	registerToolWithExecutor(pi, {
		name: "verifier_override",
		label: "Verifier Override",
		description:
			"Record an explicit user-approved completion override for the current acceptance contract. " +
			"The isolated verifier audits with limited context and can misjudge a FAIL/BLOCK (for example an environment-limited check it cannot run, or an out-of-scope finding). " +
			"Call ask_user FIRST and present BOTH the verifier verdict with its report AND your counter-assessment. " +
			"Only after the user explicitly approves completion may you call this tool. " +
			"The approval is bound to the contract, expires, appears in /workflow approvals, and is the ONLY way a non-PASS verdict still completes. " +
			"Never call this without an explicit user approval, and never to skip a bound mandatory eval set.",
		parameters: Params,
		execute: explicitDispatchHandler("subagent-tool", async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const { reason, contract: suppliedContract } = params as { reason?: string; contract?: string };
			const cwd = ctx.cwd || process.cwd();
			let contract = getExecutionContract();
			const contractText = (suppliedContract || "").trim();
			if (contractText) {
				const bound = bindAcceptanceContract(contractText, "plan");
				if ("error" in bound) {
					return { content: [{ type: "text" as const, text: "Override blocked: the supplied acceptance contract is incomplete; it must state a non-empty Objective." }], details: { error: true, completionBlocked: true, reason: "incomplete supplied acceptance contract" } };
				}
				setExecutionContract(bound);
				contract = bound;
			}
			if (!contract || !contract.objective.trim()) {
				return { content: [{ type: "text" as const, text: "Override blocked: no acceptance contract is bound or supplied. Pass the exact contract the user approved to verifier_override." }], details: { error: true, completionBlocked: true, reason: "no approved acceptance contract" } };
			}
			const scope = verificationScope(cwd, contract.fingerprint);
			// A bound mandatory eval set cannot be overridden away.
			if (contract.requiredEval) {
				const gate = checkRequiredEvalBinding(cwd, contract.requiredEval);
				setEvalGate(gate, scope);
				if (!gate.ok) {
					return { content: [{ type: "text" as const, text: `Override blocked: ${gate.reason} A user override cannot skip a bound mandatory eval set.` }], details: { error: true, completionBlocked: true, reason: "required eval gate not satisfied" } };
				}
			} else setEvalGate(undefined, scope);
			// The override is an escape hatch for a genuine non-PASS/absent verdict only.
			// A current verifier PASS means no override is needed; refusing prevents an
			// accidental blanket bypass of healthy, verifiable work.
			const manifest = buildWorkspaceManifest(cwd, contract.fingerprint);
			if (canComplete(getVerifierReceipt(scope), contract, manifest.hash, contract.requiredEval ? { ok: true } : undefined)) {
				return { content: [{ type: "text" as const, text: "Override refused: a current verifier PASS already satisfies this contract. No override is needed; call show_report to complete." }], details: { error: true, completionBlocked: true, reason: "contract already verifier-PASSed" } };
			}
			const decision = grantCompletionOverride(cwd, contract, reason);
			const advice = decision.approved
				? `Override recorded (${decision.proposalHash}). show_report may now complete this contract without a verifier PASS. It is surfaced in /workflow approvals and the completion report.`
				: `Override not recorded: ${decision.reason}`;
			return {
				content: [{ type: "text" as const, text: advice }],
				details: { status: decision.approved ? "APPROVED" : decision.status, overrideApproved: decision.approved, proposalHash: decision.proposalHash, reason: decision.reason },
			};
		}) as any,
	});
}
