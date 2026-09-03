// ABOUTME: The single completion gate. Every write-capable surface (PLAN report,
// ABOUTME: SPEC report, pipeline final advance, TEAM completion via show_report)
// ABOUTME: flows through completeDecision. User /report is a report, not a claim,
// ABOUTME: and is never gated.
// ABOUTME: A contract must contain at least one executable [cmd]
// ABOUTME: assertion; natural-language items are advisory and can never PASS.

import { bindAcceptanceContract, type AcceptanceContract } from "./execution-contract.ts";
import type { VerifierReceipt } from "./verifier-runtime.ts";
import { canComplete } from "./verifier-runtime.ts";

export type CompletionSurface = "pipeline-complete" | "plan-show-report" | "spec-show-report" | "agent-show-report" | "user-report";

export const INCOMPLETE_CONTRACT_REASON =
	"合同不可验证：需要至少一条 [cmd] 可执行验收命令。自然语言条目由 verifier 审查，不能替代命令执行。\n" +
	"请补充 ## Contract 清单，例如：\n" +
	"- [cmd] npm test";
export const MISSING_RECEIPT_REASON = "This execution requires a deterministic verifier PASS before completion.";
export const STALE_RECEIPT_REASON = "The verifier receipt is missing, failed, or bound to a different plan/workspace.";

export function verificationRequired(input: {
	surface: CompletionSurface;
	contract?: AcceptanceContract;
}): boolean {
	if (input.surface === "user-report") return false;
	if (["pipeline-complete", "plan-show-report", "spec-show-report"].includes(input.surface)) return true;
	// A bound contract (even one without executable commands) gates plan/spec
	// and generic agent show_report — an unverifiable contract must refuse
	// completion, not skip it.
	return !!input.contract;
}

export function completeDecision(input: {
	surface: CompletionSurface;
	contract?: AcceptanceContract;
	receipt?: VerifierReceipt;
	workspaceManifestHash?: string;
}): { allowed: boolean; reason?: string } {
	if (!verificationRequired({ surface: input.surface, contract: input.contract })) return { allowed: true };
	if (!input.contract || input.contract.mandatory.length === 0) {
		return { allowed: false, reason: INCOMPLETE_CONTRACT_REASON };
	}
	if (!input.receipt) return { allowed: false, reason: MISSING_RECEIPT_REASON };
	if (!canComplete(input.receipt, input.contract, input.workspaceManifestHash)) {
		return { allowed: false, reason: STALE_RECEIPT_REASON };
	}
	return { allowed: true };
}

/** Back-compat alias kept for tests and long imports. */
export function completionDecision(input: {
	surface: CompletionSurface;
	contract?: AcceptanceContract;
	receipt?: VerifierReceipt;
	workspaceManifestHash?: string;
}): { allowed: boolean; reason?: string } {
	return completeDecision(input);
}

/** Shipped complete-gate for every pipeline, including plan-build whose last phase is build. */
export function pipelineCompleteDecision(
	planText: string,
	receipt: VerifierReceipt | undefined,
	workspaceManifestHash?: string,
): { allowed: boolean; reason?: string; contract?: AcceptanceContract } {
	const bound = bindAcceptanceContract(planText, "pipeline");
	if ("error" in bound) return { allowed: false, reason: INCOMPLETE_CONTRACT_REASON };
	const decision = completeDecision({
		surface: "pipeline-complete",
		contract: bound,
		receipt,
		workspaceManifestHash,
	});
	return { ...decision, contract: bound };
}
