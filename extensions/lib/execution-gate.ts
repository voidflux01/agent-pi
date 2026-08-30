// ABOUTME: Completion gate for plan/spec show_report and any pipeline last-phase advance.
// ABOUTME: Gating keys on a bound acceptance contract, not on mode — PLAN, SPEC, TEAM,
// ABOUTME: and NORMAL-with-approved-plan all verify once a contract is bound. User /report
// ABOUTME: is not a completion claim and is never blocked by verification.

import { resolveAcceptanceContract, type AcceptanceContract } from "./execution-contract.ts";
import type { VerifierReceipt } from "./verifier-runtime.ts";
import { canComplete } from "./verifier-runtime.ts";

export type CompletionSurface = "pipeline-complete" | "plan-show-report" | "spec-show-report" | "user-report";

export const INCOMPLETE_CONTRACT_REASON = "合同不全：缺少 ## Contract 或 ## Verification 清单。";
export const MISSING_RECEIPT_REASON = "This execution requires an independent verifier PASS before completion.";
export const STALE_RECEIPT_REASON = "The verifier receipt is missing, failed, or bound to a different plan.";

export function verificationRequired(input: {
	surface: CompletionSurface;
	contract?: AcceptanceContract;
}): boolean {
	if (input.surface === "user-report") return false;
	if (input.surface === "pipeline-complete") return true;
	// Any show_report (plan or spec) is gated only when an acceptance contract is bound.
	return !!input.contract && input.contract.criteria.length > 0;
}

export function completionDecision(input: {
	surface: CompletionSurface;
	contract?: AcceptanceContract;
	receipt?: VerifierReceipt;
	workspaceHash?: string;
}): { allowed: boolean; reason?: string } {
	if (!verificationRequired({ surface: input.surface, contract: input.contract })) return { allowed: true };
	if (!input.contract || input.contract.criteria.length === 0) {
		return { allowed: false, reason: INCOMPLETE_CONTRACT_REASON };
	}
	if (!input.receipt) return { allowed: false, reason: MISSING_RECEIPT_REASON };
	if (!canComplete(input.receipt, input.contract, input.workspaceHash)) {
		return { allowed: false, reason: STALE_RECEIPT_REASON };
	}
	return { allowed: true };
}

/** Shipped complete-gate for every pipeline, including plan-build whose last phase is build. */
export function pipelineCompleteDecision(
	planText: string,
	receipt: VerifierReceipt | undefined,
	workspaceHash?: string,
	previous?: AcceptanceContract,
): { allowed: boolean; reason?: string; contract?: AcceptanceContract } {
	const bound = resolveAcceptanceContract(planText, "pipeline", previous);
	if ("error" in bound) return { allowed: false, reason: INCOMPLETE_CONTRACT_REASON };
	const decision = completionDecision({
		surface: "pipeline-complete",
		contract: bound,
		receipt,
		workspaceHash,
	});
	return { ...decision, contract: bound };
}