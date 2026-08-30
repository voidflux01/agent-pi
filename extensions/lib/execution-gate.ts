// ABOUTME: Completion gate for PLAN show_report and any pipeline last-phase advance.
// ABOUTME: User /report is not a completion claim and is never blocked by verification.

import { resolveAcceptanceContract, type AcceptanceContract } from "./execution-contract.ts";
import type { VerifierReceipt } from "./verifier-runtime.ts";
import { canComplete } from "./verifier-runtime.ts";

export type CompletionSurface = "pipeline-complete" | "plan-show-report" | "user-report";

export const INCOMPLETE_CONTRACT_REASON = "合同不全：缺少 ## Contract 或 ## Verification 清单。";
export const MISSING_RECEIPT_REASON = "This execution requires an independent verifier PASS before completion.";
export const STALE_RECEIPT_REASON = "The verifier receipt is missing, failed, or bound to a different plan.";

export function verificationRequired(surface: CompletionSurface, mode?: string): boolean {
	if (surface === "user-report") return false;
	if (surface === "plan-show-report") return (mode || "").toUpperCase() === "PLAN";
	return surface === "pipeline-complete";
}

export function completionDecision(input: {
	surface: CompletionSurface;
	mode?: string;
	contract?: AcceptanceContract;
	receipt?: VerifierReceipt;
	workspaceHash?: string;
}): { allowed: boolean; reason?: string } {
	if (!verificationRequired(input.surface, input.mode)) return { allowed: true };
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
