import { describe, expect, test } from "bun:test";
import {
	checkResultCompliance,
	composeAgentResult,
	contractGateEnabled,
} from "../lib/agent-result-contract.ts";

const GOOD = [
	"working...",
	"## RESULT",
	"done: true",
	"summary: added the parser and two unit tests",
	"- files: src/parser.ts",
	"- verification: bun test -> 12 pass",
	"- remaining: none",
	"## END",
].join("\n");

describe("checkResultCompliance", () => {
	test("accepts a well-formed block", () => {
		const c = checkResultCompliance(GOOD);
		expect(c.ok).toBe(true);
		expect(c.problems).toEqual([]);
	});

	test("flags a missing block", () => {
		const c = checkResultCompliance("just some chatter, no marker");
		expect(c.ok).toBe(false);
		expect(c.problems).toContain("no ## RESULT block");
	});

	test("flags an empty transcript", () => {
		expect(checkResultCompliance("").ok).toBe(false);
		expect(checkResultCompliance("   \n  ").ok).toBe(false);
	});

	test('flags a missing "done:" line', () => {
		const bad = "## RESULT\nsummary: looks fine\n## END";
		expect(checkResultCompliance(bad).problems).toContain('missing "done:" line');
	});

	test('flags a missing "summary:" line', () => {
		const bad = "## RESULT\ndone: false\n## END";
		expect(checkResultCompliance(bad).problems).toContain('missing "summary:"');
	});

	test("flags an unclosed block", () => {
		const bad = GOOD.split("\n").filter((l) => l !== "## END").join("\n");
		expect(checkResultCompliance(bad).problems).toContain("block not closed with ## END");
	});
});

describe("composeAgentResult contract gate", () => {
	const base = {
		agent: "tester",
		status: "done" as const,
		exitCode: 0,
		elapsedMs: 1000,
		outputText: GOOD,
		fullOutputPath: "/tmp/x.txt",
	};

	test("clean result stays silent", () => {
		const out = composeAgentResult(base);
		expect(out.contractProblems).toEqual([]);
		expect(out.content.includes("⚠️")).toBe(false);
	});

	test("broken result gets a warning suffix + problems array", () => {
		const out = composeAgentResult({ ...base, outputText: "rambled output, no marker" });
		expect(out.contractProblems.length).toBeGreaterThan(0);
		expect(out.content.includes("⚠️ RESULT contract violated")).toBe(true);
	});

	test("PI_RESULT_CONTRACT_GATE=0 silences the line but keeps problems", () => {
		process.env.PI_RESULT_CONTRACT_GATE = "0";
		try {
			expect(contractGateEnabled()).toBe(false);
			const out = composeAgentResult({ ...base, outputText: "no marker here" });
			expect(out.content.includes("⚠️")).toBe(false);
			expect(out.contractProblems.length).toBeGreaterThan(0);
		} finally {
			delete process.env.PI_RESULT_CONTRACT_GATE;
		}
	});
});
