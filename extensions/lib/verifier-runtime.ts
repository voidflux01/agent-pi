// ABOUTME: Verifier receipt construction and completion predicate.
// ABOUTME: Final status is based on explainable Objective review plus explicit eval bindings.

import type { AcceptanceContract, VerificationStatus } from "./execution-contract.ts";
import type { VerifierSubagentReport } from "./verifier-subagent.ts";

/** Advisory diagnostic attached to a receipt; it never decides completion. */
export interface VerificationResult {
	raw: string;
	status: "pass" | "fail" | "blocked";
	note?: string;
}

export interface VerificationOutcome {
	status: VerificationStatus;
	results: VerificationResult[];
}

export interface VerifierReceipt {
	version: 3;
	status: VerificationStatus;
	contractFingerprint: string;
	workspaceManifestHash: string;
	results: VerificationResult[];
	attempt: number;
	verifier?: { runId?: string; status: VerifierSubagentReport["status"]; summary: string; report?: VerifierSubagentReport };
	createdAt: string;
}

export function createVerifierReceipt(input: {
	contract: AcceptanceContract;
	workspaceManifestHash: string;
	verification: VerificationOutcome;
	attempt: number;
	verifier?: VerifierReceipt["verifier"];
}): VerifierReceipt {
	return {
		version: 3,
		status: input.verification.status,
		contractFingerprint: input.contract.fingerprint,
		workspaceManifestHash: input.workspaceManifestHash,
		results: input.verification.results,
		attempt: input.attempt,
		verifier: input.verifier,
		createdAt: new Date().toISOString(),
	};
}

/** Completion predicate: PASS + correct contract + current manifest + verifier PASS + satisfied explicit eval. */
export function canComplete(
	receipt: VerifierReceipt | undefined,
	contract: AcceptanceContract,
	currentManifestHash?: string,
	evalGate?: { ok: boolean },
): boolean {
	if (!receipt) return false;
	if (receipt.status !== "PASS") return false;
	if (receipt.verifier?.status !== "PASS" || !receipt.verifier.runId) return false;
	if (receipt.contractFingerprint !== contract.fingerprint) return false;
	if (!receipt.workspaceManifestHash || !currentManifestHash || receipt.workspaceManifestHash !== currentManifestHash) return false;
	// A contract-bound eval set is mandatory: missing, stale or failed reports block completion.
	if (contract.requiredEval && !evalGate?.ok) return false;
	return true;
}
