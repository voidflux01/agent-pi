import { describe, expect, test } from "bun:test";
import {
	checkResultCompliance,
	boundedHandoff,
	boundedOutputPreview,
	compactHandoff,
	composeAgentResult,
	contractGateEnabled,
	resultContractFailure,
} from "../lib/agent-result-contract.ts";

const GOOD = [
	"working...",
	"## RESULT",
	"role: tester",
	"done: true",
	"status: PASS",
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

	test("exposes contract failure for orchestration success gates", () => {
		expect(resultContractFailure(GOOD)).toBeUndefined();
		expect(resultContractFailure("worker stopped without a result")).toContain("no ## RESULT block");
		expect(resultContractFailure("PONG", true)).toBeUndefined();
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
		const bad = "## RESULT\nrole: tester\nstatus: PASS\nsummary: looks fine\n## END";
		expect(checkResultCompliance(bad).problems).toContain('missing "done:" line');
	});

	test('flags a missing "summary:" line', () => {
		const bad = "## RESULT\nrole: tester\ndone: false\nstatus: BLOCKED\n## END";
		expect(checkResultCompliance(bad).problems).toContain('missing "summary:"');
	});

	test('requires shared "role:" and "status:" lines', () => {
		const bad = "## RESULT\ndone: true\nsummary: looks fine\n## END";
		expect(checkResultCompliance(bad).problems).toContain('missing "role:" line');
		expect(checkResultCompliance(bad).problems).toContain('missing or invalid "status:" line');
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

	test("keeps parent-visible results compact while preserving a transcript pointer", () => {
		const verbose = `${GOOD}\n${"x".repeat(20_000)}`;
		const out = composeAgentResult({ ...base, outputText: verbose });
		expect(out.content.length).toBeLessThan(6_000);
		expect(out.content).toMatch(/Archived transcript \(20\d+ chars\):/);
		expect(out.content).toContain("/tmp/x.txt");
		expect(out.content).toContain("Do not read this file unless ## RESULT is missing");
		expect(out.content).not.toContain("Use the read tool on that path");
	});

	test("asks the parent to read the archive when RESULT is missing", () => {
		const out = composeAgentResult({ ...base, outputText: "rambled output, no marker" });
		expect(out.content).toContain("Use the read tool on that path");
		expect(out.content).not.toContain("Do not read this file unless");
	});

	test("keeps an unstructured worker fallback out of the next handoff", () => {
		const composed = composeAgentResult({ ...base, outputText: "git diff help noise" });
		const handoff = compactHandoff({ ...base, composed });
		expect(handoff).toContain("RESULT contract missing");
		expect(handoff).toContain("/tmp/x.txt");
		expect(handoff).not.toContain("git diff help noise");
	});

	test("skipContract treats raw toolkit output as the result", () => {
		const out = composeAgentResult({ ...base, outputText: "PONG", skipContract: true });
		expect(out.usedResult).toBe(true);
		expect(out.contractProblems).toEqual([]);
		expect(out.content).toContain("PONG");
		expect(out.content).not.toContain("no ## RESULT block found");
		expect(out.content).not.toContain("⚠️");
		expect(out.content).toContain("Do not read this file unless");
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

describe("bounded structured-output previews", () => {
	test("preserves complete phase handoffs", () => {
		const source = "head".repeat(1000) + "ARCHIVE_POINTER";
		const handoff = boundedHandoff(source, 120);
		expect(handoff).toBe(source);
		expect(handoff).toContain("ARCHIVE_POINTER");
	});

	test("preserves short previews exactly", () => {
		expect(boundedOutputPreview("short")).toBe("short");
	});

	test("preserves complete long previews", () => {
		const preview = boundedOutputPreview("x".repeat(10_000), 120);
		expect(preview).toHaveLength(10_000);
	});
});
