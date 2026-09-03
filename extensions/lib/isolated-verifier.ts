// ABOUTME: Legacy deterministic evidence runner plus the independent acceptance verifier.
// ABOUTME: Completion paths must use runAcceptanceVerifier; the legacy entry point is kept
// ABOUTME: for low-level tests and callers that explicitly need assertion execution only.

import type { AcceptanceContract } from "./execution-contract.ts";
import type { VerifierReceipt } from "./verifier-runtime.ts";
import { createVerifierReceipt } from "./verifier-runtime.ts";
import { runDeterministicVerification, type VerifierConfig } from "./deterministic-verifier.ts";
import { buildWorkspaceManifest } from "./workspace-manifest.ts";
import { runVerifierSubagent, type VerifierSubagentReport } from "./verifier-subagent.ts";
import { inspectContractQuality } from "./verifier-quality.ts";

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

export async function runAcceptanceVerifier(input: {
	cwd: string;
	contract: AcceptanceContract;
	attempt: number;
	config?: VerifierConfig;
	parentRunId?: string;
	mode?: string;
	model?: string;
	signal?: AbortSignal;
	contractText?: string;
	}): Promise<{ receipt?: VerifierReceipt; error?: string }> {
	if (input.contract.mandatory.length === 0) {
		return { error: "Verifier requires an approved acceptance contract with executable assertions." };
	}
	const before = buildWorkspaceManifest(input.cwd, input.contract.fingerprint);
	const quality = inspectContractQuality(input.contract);
	const deterministic = await runDeterministicVerification(input.contract, input.cwd, input.config);
	const deterministicEvidence = deterministic.results.map((result, index) => `${index + 1}. ${result.raw} => ${result.status}${result.note ? ` (${result.note})` : ""}`).join("\n");
	const subagent = await runVerifierSubagent({
		cwd: input.cwd,
		contract: input.contract,
		parentRunId: input.parentRunId,
		mode: input.mode,
		model: input.model,
		deterministicEvidence,
		contractText: input.contractText,
		signal: input.signal,
	});
	if (!subagent.report) return { error: subagent.error || "独立 verifier 未返回有效 VERIFIER RESULT。" };
	const report: VerifierSubagentReport = {
		...subagent.report,
		contract: quality.status === "PASS" ? subagent.report.contract : { status: "BLOCKED", findings: [...subagent.report.contract.findings, ...quality.findings] },
		 hard_blockers: [...subagent.report.hard_blockers, ...quality.findings],
	};
	const blockingReviewFindings = report.review.findings.filter((finding) => finding.severity === "CRITICAL" || finding.severity === "HIGH");
	if (blockingReviewFindings.length > 0) {
		report.hard_blockers.push(...blockingReviewFindings.map((finding) => `${finding.id || "review"}: ${finding.title || finding.evidence || "high-severity review finding"}`));
	}
	let verification = deterministic;
	const after = buildWorkspaceManifest(input.cwd, input.contract.fingerprint);
	if (after.hash !== before.hash) {
		verification = { status: "BLOCKED", results: [...verification.results, { kind: "advisory", raw: "[workspace] verifier command mutation", status: "blocked", note: "verification commands changed the workspace" }] };
	}
	if (report.status !== "PASS" || quality.status !== "PASS" || blockingReviewFindings.length > 0) verification = { status: report.status === "FAIL" || blockingReviewFindings.some((finding) => finding.severity === "CRITICAL") ? "FAIL" : "BLOCKED", results: [...verification.results, { kind: "advisory", raw: "[subagent] independent acceptance and code review", status: "blocked", note: report.summary }] };
	return { receipt: createVerifierReceipt({
		contract: input.contract,
		workspaceManifestHash: after.hash,
		verification,
		attempt: input.attempt,
		verifierRequired: true,
		verifier: { runId: subagent.runId, status: report.status, summary: report.summary, report },
	}) };
}
