// ABOUTME: User-approved completion override for a verifier non-PASS verdict.
// ABOUTME: The isolated verifier has limited context and can misjudge. A parent
// ABOUTME: that disputes a FAIL/BLOCK verdict may ask the user to arbitrate; an
// ABOUTME: explicit approval is recorded here, bound to the contract fingerprint
// ABOUTME: with a TTL, and honored by the completion gates. Only a recorded user
// ABOUTME: approval grants this — a parent asserting it alone never flips the gate.

import { checkApproval, recordApproval, type ApprovalDecision, type ApprovalProposal } from "./workflow-approval-gate.ts";

/** Canonical action for a completion override. Approval records carry it for audit. */
export const OVERRIDE_ACTION = "override-verifier-block";

export const OVERRIDE_TITLE = "User override: complete despite verifier non-PASS";

/** A contract-shaped value: fingerprint uniquely identifies the acceptance contract. */
export interface OverrideContract {
	fingerprint: string;
	objective?: string;
}

/** Build the stable proposal the gate checks and the grant tool records. */
export function overrideProposal(contract: OverrideContract): ApprovalProposal {
	return {
		title: OVERRIDE_TITLE,
		action: OVERRIDE_ACTION,
		scope: contract.fingerprint,
		artifacts: contract.objective ? [`objective: ${contract.objective.slice(0, 200)}`] : [],
	};
}

/** Fail-closed: true only for a matching, unexpired APPROVED override record. */
export function hasCompletionOverride(cwd: string, contract: OverrideContract): boolean {
	return checkApproval(cwd, overrideProposal(contract)).approved;
}

/** Record the user's explicit decision to accept completion despite a non-PASS verdict. */
export function grantCompletionOverride(cwd: string, contract: OverrideContract, reason?: string): ApprovalDecision {
	return recordApproval(cwd, overrideProposal(contract), true, reason);
}

/** Request the override pending user decision (resumable; listing surfaces it). */
export function requestCompletionOverride(cwd: string, contract: OverrideContract): ApprovalDecision {
	return checkApproval(cwd, overrideProposal(contract));
}
