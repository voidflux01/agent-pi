// ABOUTME: The single completion gate. Every write-capable surface (PLAN report,
// ABOUTME: SPEC report, pipeline final advance, TEAM completion via show_report)
// ABOUTME: flows through completeDecision. User /report is a report, not a claim,
// ABOUTME: and is never gated.
// ABOUTME: Completion requires an explainable Objective review, not a command marker.

import { bindAcceptanceContract, type AcceptanceContract } from "./execution-contract.ts";
import type { VerifierReceipt } from "./verifier-runtime.ts";
import { canComplete } from "./verifier-runtime.ts";

export type CompletionSurface = "pipeline-complete" | "plan-show-report" | "spec-show-report" | "agent-show-report" | "user-report";

export const INCOMPLETE_CONTRACT_REASON =
	"合同不可验证：需要非空 Objective，且由独立 verifier 提供可解释的满足性判断。";
export const MISSING_RECEIPT_REASON = "This execution requires a deterministic verifier PASS before completion.";
export const STALE_RECEIPT_REASON = "The verifier receipt is missing, failed, or bound to a different plan/workspace.";
export const REQUIRED_EVAL_REASON =
	"The confirmed contract binds a mandatory eval set, but no fresh PASS report satisfies it. " +
	"Run eval_run with the bound eval set (or fix the failing case), then re-run verify_execution.";
export const OVERRIDE_ALLOWED_REASON =
	"User-approved override: completion accepted despite no verifier PASS. The override cannot skip a bound mandatory eval set.";

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
	evalGate?: { ok: boolean };
	/** An explicit user-approved override for this contract (see completion-override). */
	overrideActive?: boolean;
}): { allowed: boolean; reason?: string } {
	if (!verificationRequired({ surface: input.surface, contract: input.contract })) return { allowed: true };
	if (!input.contract || !input.contract.objective.trim()) {
		return { allowed: false, reason: INCOMPLETE_CONTRACT_REASON };
	}
	const evalSatisfied = !(input.contract.requiredEval && input.evalGate?.ok !== true);
	if (input.overrideActive) {
		// Override escapes only the verifier PASS requirement, never a mandatory eval binding.
		if (!evalSatisfied) return { allowed: false, reason: REQUIRED_EVAL_REASON };
		return { allowed: true, reason: OVERRIDE_ALLOWED_REASON };
	}
	if (!evalSatisfied) return { allowed: false, reason: REQUIRED_EVAL_REASON };
	if (!input.receipt) return { allowed: false, reason: MISSING_RECEIPT_REASON };
	if (!canComplete(input.receipt, input.contract, input.workspaceManifestHash, input.evalGate)) {
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
	evalGate?: { ok: boolean };
	overrideActive?: boolean;
}): { allowed: boolean; reason?: string } {
	return completeDecision(input);
}

/** Shipped complete-gate for every pipeline, including plan-build whose last phase is build. */
export function pipelineCompleteDecision(
	planText: string,
	receipt: VerifierReceipt | undefined,
	workspaceManifestHash?: string,
	evalGate?: { ok: boolean },
	overrideActive?: boolean,
): { allowed: boolean; reason?: string; contract?: AcceptanceContract } {
	if (!planText.trim()) return { allowed: false, reason: INCOMPLETE_CONTRACT_REASON };
	const bound = bindAcceptanceContract(planText, "pipeline");
	if ("error" in bound) return { allowed: false, reason: INCOMPLETE_CONTRACT_REASON };
	const decision = completeDecision({
		surface: "pipeline-complete",
		contract: bound,
		receipt,
		workspaceManifestHash,
		evalGate,
		overrideActive,
	});
	return { ...decision, contract: bound };
}
