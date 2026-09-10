// ABOUTME: Independent Objective verifier: a read-only verifier subagent judges the
// ABOUTME: approved contract. No workspace command is executed to decide completion.

import type { AcceptanceContract } from "./execution-contract.ts";
import type { VerificationOutcome, VerifierReceipt } from "./verifier-runtime.ts";
import { createVerifierReceipt } from "./verifier-runtime.ts";
import { buildWorkspaceManifest } from "./workspace-manifest.ts";
import { runVerifierSubagent, type VerifierSubagentReport } from "./verifier-subagent.ts";
import { inspectContractQuality } from "./verifier-quality.ts";
import { recordEvidence } from "./evidence-store.ts";
import { join } from "node:path";

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

function fallbackVerifierReport(input: { objective: string; reason: string }): VerifierSubagentReport {
	// A missing independent report cannot be compensated by anything else, so it
	// blocks instead of minting a PASS receipt.
	return {
		status: "BLOCKED",
		summary: input.reason,
		requirements: [{ requirement: input.objective, status: "BLOCKED", evidence: "The independent verifier returned no usable report." }],
		contract: { status: "BLOCKED", findings: [] },
		review: { status: "BLOCKED", findings: [] },
		behavior: { status: "BLOCKED", findings: [], tests: { discovered: 0, executed: 0, failed: 0, skipped: 0 } },
		quality: { status: "WARN", findings: [input.reason] },
		security: { status: "WARN", findings: [] },
		hard_blockers: [input.reason],
		warnings: [input.reason],
	};
}

export async function runAcceptanceVerifier(input: {
	cwd: string;
	contract: AcceptanceContract;
	attempt: number;
	parentRunId?: string;
	mode?: string;
	model?: string;
	signal?: AbortSignal;
	contractText?: string;
	previousReport?: VerifierSubagentReport;
}): Promise<{ receipt?: VerifierReceipt; error?: string }> {
	const before = buildWorkspaceManifest(input.cwd, input.contract.fingerprint);
	const quality = inspectContractQuality(input.contract);
	const subagent = await runVerifierSubagent({
		cwd: input.cwd,
		contract: input.contract,
		parentRunId: input.parentRunId,
		mode: input.mode,
		model: input.model,
		contractText: input.contractText,
		previousReport: input.previousReport,
		signal: input.signal,
	});
	const rawReport = subagent.report || fallbackVerifierReport({
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
	// The verifier subagent is read-only, so any workspace change during the run
	// means the audit cannot be trusted for this manifest.
	let verification: VerificationOutcome = { status: "PASS", results: [] };
	const after = buildWorkspaceManifest(input.cwd, input.contract.fingerprint);
	if (after.hash !== before.hash) {
		verification = { status: "BLOCKED", results: [{ raw: "[workspace] verifier mutated the workspace", status: "blocked", note: "the workspace changed while verification ran" }] };
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
			verifier: { runId: subagent.runId, status: report.status, summary: report.summary, report },
		})
	};
}
