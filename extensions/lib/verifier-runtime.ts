// ABOUTME: Verifier receipt construction and completion predicate.
// ABOUTME: Final status is decided solely by deterministic assertions.

import type { AcceptanceContract, VerificationStatus } from "./execution-contract.ts";
import type { AssertionResult, DeterministicVerification } from "./deterministic-verifier.ts";

export interface VerifierReceipt {
	version: 2;
	status: VerificationStatus;
	contractFingerprint: string;
	workspaceManifestHash: string;
	results: AssertionResult[];
	attempt: number;
	verifierModel?: string;
	createdAt: string;
}

export function createVerifierReceipt(input: {
	contract: AcceptanceContract;
	workspaceManifestHash: string;
	verification: DeterministicVerification;
	attempt: number;
	verifierModel?: string;
}): VerifierReceipt {
	return {
		version: 2,
		status: input.verification.status,
		contractFingerprint: input.contract.fingerprint,
		workspaceManifestHash: input.workspaceManifestHash,
		results: input.verification.results,
		attempt: input.attempt,
		verifierModel: input.verifierModel,
		createdAt: new Date().toISOString(),
	};
}

/** Completion predicate: PASS + correct contract + current workspace manifest + all assertions green. */
export function canComplete(
	receipt: VerifierReceipt | undefined,
	contract: AcceptanceContract,
	currentManifestHash?: string,
): boolean {
	if (!receipt) return false;
	if (receipt.status !== "PASS") return false;
	if (receipt.contractFingerprint !== contract.fingerprint) return false;
	if (!receipt.workspaceManifestHash || !currentManifestHash || receipt.workspaceManifestHash !== currentManifestHash) return false;
	if (receipt.results.length === 0 || !receipt.results.every(r => r.status === "pass")) return false;
	return true;
}
