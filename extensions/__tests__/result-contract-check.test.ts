import { describe, expect, test } from "bun:test";
import {
	checkResultCompliance,
	boundedHandoff,
	boundedOutputPreview,
	compactHandoff,
	composeAgentResult,
	contractGateEnabled,
	normalizeResultContract,
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

	test("accepts common localized result field labels", () => {
		const localized = [
			"## RESULT",
			"角色: SCOUT",
			"完成: 是",
			"状态: PASS",
			"总结: 已完成只读侦察",
			"发现:",
			"- no changes",
			"## END",
		].join("\n");
		const normalized = normalizeResultContract(localized);
		expect(normalized?.text).toContain("role: SCOUT");
		expect(normalized?.text).toContain("done: true");
		expect(normalized?.text).toContain("status: PASS");
		expect(normalized?.text).toContain("summary: 已完成只读侦察");
		expect(checkResultCompliance(normalized?.text || localized).ok).toBe(true);
		expect(resultContractFailure(localized)).toBeUndefined();
	});

	test("rejects localized result and end markers", () => {
		const localized = [
			"## 结果",
			"角色: SCOUT",
			"完成: 是",
			"状态: PASS",
			"总结: 已完成只读侦察",
			"## 结束",
		].join("\n");
		expect(normalizeResultContract(localized)).toBeUndefined();
		expect(resultContractFailure(localized)).toContain("no ## RESULT block");
	});

	test("flags an unclosed block", () => {
		const bad = GOOD.split("\n").filter((l) => l !== "## END").join("\n");
		expect(checkResultCompliance(bad).problems).toContain("block not closed with ## END");
	});
});

describe("deterministic autofix (zero-token drift repair)", () => {
	test("maps status value aliases to the enum", () => {
		const drift = [
			"## RESULT",
			"role: tester",
			"done: true",
			"status: SUCCESS",
			"summary: done",
			"## END",
		].join("\n");
		const normalized = normalizeResultContract(drift);
		expect(normalized?.text).toContain("status: PASS");
		expect(resultContractFailure(drift)).toBeUndefined();
	});

	test("maps done value aliases", () => {
		expect(resultContractFailure("## RESULT\nrole: t\ndone: yes\nstatus: PASS\nsummary: ok\n## END")).toBeUndefined();
		expect(resultContractFailure("## RESULT\n角色: t\n完成: 已完成\n状态: FAILED\n总结: 坏\n## END", false)).toBeUndefined();
	});

	test("injects role from spawn identity when dropped", () => {
		const raw = "## RESULT\ndone: true\nstatus: PASS\nsummary: ok\n## END";
		const normalized = normalizeResultContract(raw, "SCOUT");
		expect(normalized?.text).toContain("role: scout");
		expect(resultContractFailure(raw, false, "SCOUT")).toBeUndefined();
		expect(resultContractFailure(raw)).toContain('missing "role:" line');
	});

	test("passes the composed agent name through the sanitized role line", () => {
		const raw = "## RESULT\ndone: true\nstatus: PASS\nsummary: ok\n## END";
		const out = composeAgentResult({ agent: "SA3 (SCOUT)", status: "done", exitCode: 0, elapsedMs: 1, outputText: raw, fullOutputPath: "/tmp/x.txt" });
		expect(out.usedResult).toBe(true);
		expect(out.contractProblems).toEqual([]);
		expect(out.content).toContain("role: sa3-scout-");
	});

	test("falls back to first findings bullet for summary", () => {
		const raw = "## RESULT\nrole: t\ndone: true\nstatus: PASS\nfindings:\n- fixed auth timeout\n- added tests\n## END";
		const normalized = normalizeResultContract(raw);
		expect(normalized?.text).toContain("summary: fixed auth timeout");
		expect(resultContractFailure(raw)).toBeUndefined();
	});

	test("auto-closes a missing ## END closer", () => {
		const raw = "## RESULT\nrole: t\ndone: true\nstatus: PASS\nsummary: ok";
		const normalized = normalizeResultContract(raw);
		expect(normalized?.text.endsWith("## END")).toBe(true);
		expect(resultContractFailure(raw)).toBeUndefined();
	});

	test("empty transcripts are never auto-fixed", () => {
		expect(normalizeResultContract("")).toBeUndefined();
		expect(resultContractFailure("")).toContain("empty transcript");
		expect(resultContractFailure("   \n  ")).toContain("empty transcript");
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

	test("rejects malformed result blocks before they reach the parent", () => {
		const malformed = "## RESULT\n角色: tester\n完成: 是\n## END";
		const out = composeAgentResult({ ...base, outputText: malformed });
		expect(out.usedResult).toBe(false);
		expect(out.content).toContain("[RESULT contract rejected]");
		expect(out.content).toContain("Use the read tool on that path");
		expect(out.content).not.toContain("角色: tester");
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
