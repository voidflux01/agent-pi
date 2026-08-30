// ABOUTME: Verifier receipt construction and (optional) LLM explanation layer.
// ABOUTME: The final status is decided solely by deterministic assertions; the LLM
// ABOUTME: may only explain results and suggest fixes — it can never change PASS/FAIL.

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

function markup(value: string): string {
	return `<result>\n${value.slice(0, 12000)}\n</result>`;
}

/**
 * Optional LLM explanation prompt. The model describes what failed and how to fix
 * it; it must not re-assert PASS/FAIL — the deterministic status is authoritative.
 */
export function buildVerificationExplanationPrompt(input: {
	contract: AcceptanceContract;
	verification: DeterministicVerification;
	workspaceManifestHash: string;
}): string {
	const lines = input.verification.results.map(r =>
		`- ${r.status.toUpperCase()} [${r.kind}] ${r.raw}${r.note ? ` — ${r.note}` : ""}`,
	).join("\n");
	return `You are an explanatory layer only. The deterministic verifier has decided: ${input.verification.status}.
Do not change the status. Explain what passed, what failed, and concrete remediation steps for each failed/blocked assertion.

Objective: ${input.contract.objective}
Workspace manifest hash: ${input.workspaceManifestHash}
${markup(lines)}

Reply with:
summary: <2-3 sentences>
suggestions:
- <concrete fix for each failed/blocked assertion>`;
}

/** Extract the LLM's explanation; never used for the PASS decision. */
export function parseVerifierExplanation(output: string): { summary?: string; suggestions: string[] } {
	const summary = output.match(/^summary:\s*(.+)$/im)?.[1]?.trim();
	const suggestions = [...output.matchAll(/^\s*-\s+(.+)$/gm)].map(m => m[1].trim()).filter(Boolean);
	return { summary, suggestions };
}