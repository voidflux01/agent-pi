// ABOUTME: Verification entry point — deterministic assertions only. No child pi
// ABOUTME: process, no dispatch authorization, no LLM in the decision path.
// ABOUTME: Name kept for callers; semantics are execution-based verification.

import type { AcceptanceContract } from "./execution-contract.ts";
import type { VerifierReceipt } from "./verifier-runtime.ts";
import { createVerifierReceipt } from "./verifier-runtime.ts";
import { runDeterministicVerification, type VerifierConfig } from "./deterministic-verifier.ts";
import { buildWorkspaceManifest } from "./workspace-manifest.ts";

export async function runIsolatedVerifier(input: {
	cwd: string;
	contract: AcceptanceContract;
	attempt: number;
	config?: VerifierConfig;
}): Promise<{ receipt?: VerifierReceipt; error?: string }> {
	const manifest = buildWorkspaceManifest(input.cwd, input.contract.fingerprint);
	let verification = await runDeterministicVerification(input.contract, input.cwd, input.config);
	const afterManifest = buildWorkspaceManifest(input.cwd, input.contract.fingerprint);
	if (afterManifest.hash !== manifest.hash) {
		verification = {
			status: "BLOCKED",
			results: [
				...verification.results,
				{ kind: "advisory", raw: "[workspace] verifier command mutation", status: "blocked", note: "verification commands changed the workspace" },
			],
		};
	}
	return {
		receipt: createVerifierReceipt({
			contract: input.contract,
			workspaceManifestHash: afterManifest.hash,
			verification,
			attempt: input.attempt,
		}),
	};
}
