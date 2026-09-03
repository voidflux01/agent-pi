import { describe, expect, it } from "vitest";
import { bindAcceptanceContract } from "../lib/execution-contract.ts";
import { inspectContractQuality } from "../lib/verifier-quality.ts";
import { buildVerifierPrompt, parseVerifierReport } from "../lib/verifier-subagent.ts";
import { runAcceptanceVerifier } from "../lib/isolated-verifier.ts";
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

describe("acceptance contract quality", () => {
	it("blocks structural-only contracts", () => {
		const result = inspectContractQuality(contract(`# Plan: x\n\n## Contract\n- [file] src/x.ts\n- [match] class X :: src/x.ts\n`));
		expect(result.status).toBe("BLOCKED");
		expect(result.findings.join(" ")).toMatch(/行为验证|结构门禁/);
	});

	it("requires explainable contract fields", () => {
		const result = inspectContractQuality(bindAcceptanceContract("# Plan: x\n\n## Verification Commands\n- [cmd] npm test\n", "plan"));
		expect(result.status).toBe("BLOCKED");
		expect(result.findings.join(" ")).toContain("Scope");
	});

	it("blocks commands that succeed when no tests are discovered", () => {
		const result = inspectContractQuality(contract(`# Plan: x\n\n## Contract\n- [cmd] mvn -q test -Dtest=X -Dsurefire.failIfNoSpecifiedTests=false\n`));
		expect(result.status).toBe("BLOCKED");
		expect(result.findings.join(" ")).toContain("无测试成功");
	});

	it("accepts a representative test command", () => {
		const result = inspectContractQuality(contract(`# Plan: x\n\n## Contract\n- [cmd] mvnd -q test\n- [match] toggleTodo :: src/todos.js\n`));
		expect(result.status).toBe("PASS");
	});

	it("does not start a verifier without executable assertions", async () => {
		const result = await runAcceptanceVerifier({
			cwd: process.cwd(),
			contract: emptyContract("# Plan: missing contract\n", "plan"),
			attempt: 1,
		});
		expect(result.receipt).toBeUndefined();
		expect(result.error).toContain("approved acceptance contract");
	});

	it("keeps verifier skills enabled and its audit prompt read-only", () => {
		const prompt = buildVerifierPrompt(contract(`# Plan: x\n\n## Contract\n- [cmd] mvnd -q test\n`));
		expect(prompt).toContain("Skills are enabled and must remain available");
		expect(prompt).toContain("must not modify any file");
		expect(prompt).toContain("read-only verification commands");
		const source = readFileSync(new URL("../lib/verifier-subagent.ts", import.meta.url), "utf8");
		expect(source).toContain('AGENT_PI_CONFIG.workers.thinking');
		expect(source).toContain('launch(initialPrompt, "read,bash,grep,find,ls", "audit")');
		expect(source).toContain('launch(repairPrompt, "read", "repair")');
		expect(source).toContain('herdrDoneExtPath = join(dirname(extDir), "herdr-done.ts")');
		expect(source).toContain('herdrLabel: "VERIFIER"');
		expect(source).toContain("withSessionResume");
		expect(source).toContain("Do not redo the audit");
	});

	it("passes deterministic evidence to the verifier and forbids stranded statuses", () => {
		const prompt = buildVerifierPrompt(contract(`# Plan: x\n\n## Contract\n- [cmd] mvnd -q test\n`), "1. [cmd] mvnd -q test => pass");
		expect(prompt).toContain("deterministic evidence runner has already executed");
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

	it("rejects an incomplete Markdown report when the END marker is missing", () => {
		const truncated = validVerifierResult.slice(0, validVerifierResult.indexOf("## Security"));
		expect(parseVerifierReport(truncated)).toBeUndefined();
	});

	it("uses the last valid result when an earlier block is malformed", () => {
		expect(parseVerifierReport(`## RESULT\ndone: true\nsummary: malformed\n## END\n\n${validVerifierResult}`)?.status).toBe("PASS");
	});

	it("rejects the removed verifier-specific JSON protocol", () => {
		const legacy = `## VERIFIER RESULT\n{"status":"PASS","summary":"clean"}\n## END VERIFIER RESULT`;
		expect(parseVerifierReport(legacy)).toBeUndefined();
	});

	it("rejects a contradictory PASS with hard blockers", () => {
		const contradictory = validVerifierResult.replace("## Hard Blockers\n- none", "## Hard Blockers\n- cargo test was not run");
		expect(parseVerifierReport(contradictory)).toBeUndefined();
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
