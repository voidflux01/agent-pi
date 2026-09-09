// ABOUTME: Independent Objective verifier with optional legacy deterministic evidence support.
// ABOUTME: Completion paths use runAcceptanceVerifier; old command execution remains isolated
// ABOUTME: for low-level callers and does not form a global completion gate.

import type { AcceptanceContract } from "./execution-contract.ts";
import type { VerifierReceipt } from "./verifier-runtime.ts";
import { createVerifierReceipt } from "./verifier-runtime.ts";
import { runDeterministicVerification, type VerifierConfig } from "./deterministic-verifier.ts";
import { buildWorkspaceManifest } from "./workspace-manifest.ts";
import { runVerifierSubagent, type VerifierSubagentReport } from "./verifier-subagent.ts";
import { inspectContractQuality } from "./verifier-quality.ts";
import { recordEvidence } from "./evidence-store.ts";
import { join } from "node:path";

export async function runIsolatedVerifier(input: {
	cwd: string;
	contract: AcceptanceContract;
	attempt: number;
	config?: VerifierConfig;
}): Promise<{ receipt?: VerifierReceipt; error?: string }> {
	const manifest = buildWorkspaceManifest(input.cwd, input.contract.fingerprint);
	// Legacy low-level API may still be used to exercise explicitly supplied
	// command assertions; completion paths never call this API as a command gate.
	const legacyCommands = input.contract.assertions.filter((assertion) => assertion.kind === "cmd");
	let verification = await runDeterministicVerification({ mandatory: legacyCommands }, input.cwd, input.config);
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

export function formatVerifierDiagnostics(report: VerifierSubagentReport): string {
	const review = report.review.findings
		.filter((finding) => finding.severity === "CRITICAL" || finding.severity === "HIGH")
		.map((finding) => `${finding.severity}: ${finding.title || finding.evidence || "review finding"}${finding.location ? ` @ ${finding.location}` : ""}`);
	const details = [
		report.summary,
		...report.hard_blockers,
		...report.contract.findings,
		...report.behavior.findings,
		...review,
	].filter((item) => item && !/^none$/i.test(item.trim()));
	return details.length > 0 ? details.join("; ") : "verifier returned non-PASS without diagnostic details";
}

function fallbackVerifierReport(input: { status: VerifierSubagentReport["status"]; objective: string; reason: string }): VerifierSubagentReport {
	return {
		status: input.status,
		summary: input.status === "PASS" ? `Deterministic verification passed; verifier RESULT format was invalid (${input.reason}).` : input.reason,
		requirements: [{ requirement: input.objective, status: input.status, evidence: "Deterministic workspace verification completed; optional verifier narrative was unavailable." }],
		contract: { status: input.status, findings: [] },
		review: { status: input.status, findings: [] },
		behavior: { status: input.status, findings: [], tests: { discovered: 0, executed: 0, failed: 0, skipped: 0 } },
		quality: { status: "WARN", findings: [input.reason] },
		security: { status: "WARN", findings: [] },
		hard_blockers: input.status === "PASS" ? [] : [input.reason],
		warnings: [input.reason],
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
	previousReport?: VerifierSubagentReport;
}): Promise<{ receipt?: VerifierReceipt; error?: string }> {
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
		previousReport: input.previousReport,
		signal: input.signal,
	});
	const rawReport = subagent.report || fallbackVerifierReport({
		// A deterministic PASS cannot compensate for a missing independent
		// verifier report; represent this as BLOCKED instead of minting a PASS
		// receipt with a hard blocker attached.
		status: subagent.error ? "BLOCKED" : deterministic.status,
		objective: input.contract.objective,
		reason: subagent.error || "独立 verifier 未返回有效 Markdown ## RESULT。",
	});
	const report: VerifierSubagentReport = {
		...rawReport,
		contract: quality.status === "PASS" ? rawReport.contract : { status: "BLOCKED", findings: [...rawReport.contract.findings, ...quality.findings] },
		hard_blockers: [...rawReport.hard_blockers, ...quality.findings],
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
	try {
		recordEvidence(join(input.cwd, ".context", "evidence", input.parentRunId || `verifier-${input.attempt}`), {
			id: `verifier-report-${input.attempt}-${Date.now()}`,
			type: "review",
			source: "runtime",
			value: JSON.stringify(report),
			outputPath: subagent.runId,
			timestamp: new Date().toISOString(),
		});
	} catch { }
	if (report.status !== "PASS" || quality.status !== "PASS" || blockingReviewFindings.length > 0) verification = {
		status: report.status === "FAIL" || blockingReviewFindings.some((finding) => finding.severity === "CRITICAL") ? "FAIL" : "BLOCKED",
		results: [...verification.results, {
			kind: "advisory",
			raw: "[subagent] independent acceptance and code review",
			status: "blocked",
			note: formatVerifierDiagnostics(report),
		}],
	};
	return {
		receipt: createVerifierReceipt({
			contract: input.contract,
			workspaceManifestHash: after.hash,
			verification,
			attempt: input.attempt,
			verifierRequired: true,
			verifier: { runId: subagent.runId, status: report.status, summary: report.summary, report },
		})
	};
}
