import { describe, expect, it } from "vitest";
import { bindAcceptanceContract } from "../lib/execution-contract.ts";
import { inspectContractQuality } from "../lib/verifier-quality.ts";
import { buildVerifierPrompt, parseVerifierOutput, parseVerifierReport, parseVerifierReportDetailed } from "../lib/verifier-subagent.ts";
import { formatVerifierDiagnostics } from "../lib/isolated-verifier.ts";
import { emptyContract } from "../lib/execution-contract.ts";
import { readFileSync } from "node:fs";

function contract(text: string) {
	const suffix = text.includes("## Scope") ? "" : "\n\n## Scope\nRelevant source and tests.\n\n## Acceptance Criteria\nRequested behavior works.\n\n## Evidence Requirements\nTests cover the requested behavior.\n";
	return bindAcceptanceContract(text + suffix, "plan");
}

const validVerifierResult = `## RESULT
role: verifier
done: true
status: PASS
summary: clean
findings:
- clean audit
files:
- src/example.ts:1
verification:
- PASS | npm test | 1 test passed
key_errors:
- none
remaining:
- none

## Requirements
### REQ-001
status: PASS
requirement: requested behavior works
evidence: src/example.ts:1 and npm test passed
files:
- src/example.ts:1

## Contract
status: PASS
findings:
- complete

## Review
status: PASS

## Behavior
status: PASS
tests_discovered: 1
tests_executed: 1
tests_failed: 0
tests_skipped: 0
findings:
- npm test passed

## Quality
status: PASS
findings:
- clean

## Security
status: PASS
findings:
- clean

## Hard Blockers
- none

## Warnings
- none
## END`;

describe("verifier diagnostics", () => {
	it("preserves blocker and review details instead of generic text", () => {
		const diagnostics = formatVerifierDiagnostics({
			status: "BLOCKED",
			summary: "独立验收未返回完整结果",
			requirements: [],
			contract: { status: "BLOCKED", findings: ["缺少行为证据"] },
			review: { status: "BLOCKED", findings: [{ severity: "HIGH", title: "未发现最终 RESULT", location: "verifier session" }] },
			behavior: { status: "BLOCKED", findings: ["子代理在 toolUse 后退出"] },
			quality: { status: "PASS", findings: [] },
			security: { status: "PASS", findings: [] },
			hard_blockers: ["verifier timeout"],
			warnings: [],
		});
		expect(diagnostics).toContain("独立验收未返回完整结果");
		expect(diagnostics).toContain("verifier timeout");
		expect(diagnostics).toContain("未发现最终 RESULT");
		expect(diagnostics).toContain("子代理在 toolUse 后退出");
	});
});

describe("acceptance contract quality", () => {
	it("requires a non-empty Objective", () => {
		const missing = emptyContract("# Plan: x\n", "plan");
		missing.objective = "";
		const result = inspectContractQuality(missing);
		expect(result.status).toBe("BLOCKED");
		expect(result.findings.join(" ")).toContain("Objective");
	});

	it("does not require Scope or extra evidence sections", () => {
		const result = inspectContractQuality(bindAcceptanceContract("# Plan: x\n\n## Objective\nShip it.\n", "plan"));
		expect(result.status).toBe("PASS");
	});

	it("keeps verifier entry quality focused on Objective", () => {
		const missing = emptyContract("# Plan: missing contract\n", "plan");
		missing.objective = "";
		expect(inspectContractQuality(missing).status).toBe("BLOCKED");
	});

	it("keeps verifier skills enabled and its audit prompt read-only", () => {
		const prompt = buildVerifierPrompt(contract("# Plan: x\n\n## Objective\nShip the change.\n"));
		expect(prompt).toContain("Skills are enabled and must remain available");
		expect(prompt).toContain("must not modify any file");
		expect(prompt).toContain("read-only verification commands");
		expect(prompt).not.toContain("deterministic evidence");
		const source = readFileSync(new URL("../lib/verifier-subagent.ts", import.meta.url), "utf8");
		expect(source).toContain('AGENT_PI_CONFIG.workers.thinking');
		expect(source).toContain('launch(initialPrompt, "read,bash,grep,find,ls", "audit")');
		expect(source).toContain("normalizeResultContract");
		expect(source).toContain("formatResultRepairDiagnostics({");
		expect(source).toContain("If evidence is incomplete, use done: true and status: BLOCKED");
		expect(source).toContain('herdrDoneExtPath = join(dirname(extDir), "herdr-done.ts")');
		expect(source).toContain('herdrLabel: "VERIFIER"');
		expect(source).toContain("withSessionResume");
	});

	it("forbids stranded statuses in the verifier prompt", () => {
		const prompt = buildVerifierPrompt(contract("# Plan: x\n\n## Objective\nShip the change.\n"));
		expect(prompt).toContain("never invent UNVERIFIED");
		expect(prompt).toContain("## RESULT");
		expect(prompt).not.toContain("## VERIFIER RESULT");
		expect(prompt).toContain("Do not use JSON");
	});

	it("accepts a valid result followed by trailing assistant text", () => {
		expect(parseVerifierReport(`${validVerifierResult}\n验收完成。`)).toMatchObject({ status: "PASS", summary: "clean" });
	});

	it("accepts a complete Markdown result when the model omits the END marker", () => {
		const withoutEnd = validVerifierResult.replace(/\n## END$/, "");
		expect(parseVerifierReport(withoutEnd)).toMatchObject({ status: "PASS", summary: "clean" });
	});

	it("rejects an incomplete Markdown report and explains the missing section", () => {
		const truncated = validVerifierResult.slice(0, validVerifierResult.indexOf("## Security"));
		expect(parseVerifierReport(truncated)).toBeUndefined();
		expect(parseVerifierReportDetailed(truncated).error).toContain("Security");
	});

	it("accepts wrapped evidence and annotated test counters", () => {
		const drifted = validVerifierResult
			.replace("evidence: src/example.ts:1 and npm test passed", "evidence: src/example.ts:1\nThe focused test passed.")
			.replace("tests_discovered: 1", "tests_discovered: 1 (one test)")
			.replace("tests_executed: 1", "tests_executed: 1 test")
			.replace("tests_failed: 0", "tests_failed: 0 (none)")
			.replace("tests_skipped: 0", "tests_skipped: 0 skipped");
		const report = parseVerifierReportDetailed(drifted);
		expect(report.report).toMatchObject({
			status: "PASS",
			behavior: { tests: { discovered: 1, executed: 1, failed: 0, skipped: 0 } },
		});
		expect(report.error).toBeUndefined();
	});

	it("distinguishes an empty result from an invalid rich report", () => {
		expect(parseVerifierReportDetailed("").error).toContain("empty verifier result");
		expect(parseVerifierReportDetailed("verifier stopped before reporting").error)
			.toContain("role must be verifier");
		expect(parseVerifierReportDetailed("## RESULT\nrole: verifier\ndone: true\nstatus: PASS\nsummary: incomplete\n## END").error)
			.toContain("missing section(s)");
	});

	it("rejects a complete rich report when shared RESULT markers are missing", () => {
		const unwrapped = validVerifierResult.replace(/^## RESULT\n/, "").replace(/\n## END$/, "");
		expect(parseVerifierReport(unwrapped)).toBeUndefined();
		expect(parseVerifierReportDetailed(unwrapped).error).toContain("shared RESULT contract");
	});

	it("parses persisted transcript output before process exit is considered", () => {
		const parsed = parseVerifierOutput("assistant preamble", validVerifierResult);
		expect(parsed.report).toMatchObject({ status: "PASS", summary: "clean" });
		expect(parsed.error).toBeUndefined();
	});

	it("uses the last valid result when an earlier block is malformed", () => {
		expect(parseVerifierReport(`## RESULT\ndone: true\nsummary: malformed\n## END\n\n${validVerifierResult}`)?.status).toBe("PASS");
	});

	it("rejects the removed verifier-specific JSON protocol", () => {
		const legacy = `## VERIFIER RESULT\n{"status":"PASS","summary":"clean"}\n## END VERIFIER RESULT`;
		expect(parseVerifierReport(legacy)).toBeUndefined();
	});

	it("derives overall status from reported facts instead of rejecting a contradictory PASS", () => {
		// Worker typed PASS but kept a hard blocker → derived BLOCKED, real report kept.
		const contradictory = validVerifierResult.replace("## Hard Blockers\n- none", "## Hard Blockers\n- cargo test was not run");
		const report = parseVerifierReport(contradictory);
		expect(report).not.toBeUndefined();
		expect(report?.status).toBe("BLOCKED");
		expect(report?.hard_blockers).toEqual(["cargo test was not run"]);
		expect(parseVerifierReportDetailed(contradictory).error).toBeUndefined();
	});

	it("derives FAIL when a PASS report keeps a failed requirement", () => {
		const report = parseVerifierReport(validVerifierResult.replace("## REQ-001\nstatus: PASS", "## REQ-001\nstatus: FAIL"));
		expect(report?.status).toBe("FAIL");
		expect(report?.requirements[0]).toMatchObject({ status: "FAIL", requirement: "requested behavior works" });
	});

	it("derives FAIL on a FAIL quality section under an overall PASS", () => {
		const report = parseVerifierReport(validVerifierResult.replace("## Quality\nstatus: PASS", "## Quality\nstatus: FAIL"));
		expect(report?.status).toBe("FAIL");
		expect(report?.quality).toMatchObject({ status: "FAIL" });
	});

	it("keeps PASS when a section only WARNs under an overall PASS", () => {
		const report = parseVerifierReport(validVerifierResult.replace("## Quality\nstatus: PASS", "## Quality\nstatus: WARN"));
		expect(report?.status).toBe("PASS");
		expect(report?.quality).toMatchObject({ status: "WARN" });
	});

	it("does not second-guess a conservative non-PASS that matches a clean report", () => {
		const fail = parseVerifierReport(validVerifierResult.replace("status: PASS\nsummary: clean", "status: FAIL\nsummary: needs work"));
		expect(fail?.status).toBe("FAIL");
		const blocked = parseVerifierReport(validVerifierResult.replace("status: PASS\nsummary: clean", "status: BLOCKED\nsummary: missing evidence"));
		expect(blocked?.status).toBe("BLOCKED");
	});

	it("parses structured Markdown review findings and blocked evidence", () => {
		const blocked = validVerifierResult
			.replace("status: PASS\nsummary: clean", "status: BLOCKED\nsummary: cargo evidence missing")
			.replace("## Review\nstatus: PASS", `## Review
status: PASS
### REV-001
severity: LOW
category: testing
title: Missing app-layer test
location: src/app.ts:10
evidence: Search found no matching test
recommendation: Add a focused unit test`)
			.replace("## Behavior\nstatus: PASS", "## Behavior\nstatus: BLOCKED")
			.replace("## Hard Blockers\n- none", "## Hard Blockers\n- cargo test was not run");
		const report = parseVerifierReport(blocked);
		expect(report).toMatchObject({
			status: "BLOCKED",
			summary: "cargo evidence missing",
			behavior: { status: "BLOCKED", tests: { discovered: 1, executed: 1, failed: 0, skipped: 0 } },
			review: { findings: [{ id: "REV-001", severity: "LOW", category: "testing", location: "src/app.ts:10" }] },
			hard_blockers: ["cargo test was not run"],
		});
	});
});
