import { describe, expect, test } from "bun:test";
import {
	checkResultCompliance,
	boundedHandoff,
	boundedOutputPreview,
	compactHandoff,
	buildResultFormatRepairPrompt,
	composeAgentResult,
	contractGateEnabled,
	normalizeResultContract,
	resultContractFailure,
	resultFormatRepairReason,
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

	test("exposes contract failure for strict callers and recovers process output", () => {
		expect(resultContractFailure(GOOD)).toBeUndefined();
		expect(resultContractFailure("worker stopped without a result")).toContain("no ## RESULT block");
		expect(resultContractFailure("worker returned a report", false, "scout", 0)).toBeUndefined();
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

	test("normalizes localized result and end markers", () => {
		const localized = [
			"## 结果",
			"角色: SCOUT",
			"完成: 是",
			"状态: PASS",
			"总结: 已完成只读侦察",
			"## 结束",
		].join("\n");
		const normalized = normalizeResultContract(localized);
		expect(normalized?.text).toContain("## RESULT");
		expect(normalized?.text).toContain("## END");
		expect(resultContractFailure(localized)).toBeUndefined();
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

describe("worker-owned format repair gate", () => {
	test("repairs plain prose but accepts deterministic syntax normalization", () => {
		expect(resultFormatRepairReason("worker stopped after inspection", "scout", { exitCode: 1 })).toContain("no ## RESULT block");
		expect(resultFormatRepairReason("## RESULT\nrole: scout\ndone: yes\nstatus: SUCCESS\nsummary: done\n## END", "scout", { exitCode: 0 })).toBeUndefined();
		expect(resultFormatRepairReason("", "scout", { exitCode: 0 })).toContain("empty transcript");
	});

	test("repair prompt preserves incomplete outcomes as BLOCKED", () => {
		const prompt = buildResultFormatRepairPrompt({ role: "scout", reason: "empty transcript", exitCode: 1 });
		expect(prompt).toContain("done: true and status: BLOCKED");
		expect(prompt).toContain("role: scout");
		expect(prompt).toContain("key_errors:");
		expect(prompt).toContain("## END");
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

	test("recovers an unstructured report without a format warning", () => {
		const out = composeAgentResult({ ...base, outputText: "rambled output, no marker" });
		expect(out.contractProblems).toEqual([]);
		expect(out.usedResult).toBe(true);
		expect(out.recovered).toBe(true);
		expect(out.content).not.toContain("RESULT contract violated");
		expect(out.content).toContain("role: tester");
	});

	test("repairs malformed result fields before parent handoff", () => {
		const malformed = "## RESULT\n角色: tester\n完成: 是\n## END";
		const out = composeAgentResult({ ...base, outputText: malformed });
		expect(out.usedResult).toBe(true);
		expect(out.contractProblems).toEqual([]);
		expect(out.content).toContain("role: tester");
		expect(out.content).toContain("status: PASS");
		expect(out.content).not.toContain("RESULT contract rejected");
	});

	test("preserves failed process outcomes while recovering their wrapper", () => {
		const out = composeAgentResult({ ...base, exitCode: 1, outputText: "worker crashed after inspection" });
		expect(out.usedResult).toBe(true);
		expect(out.contractProblems).toEqual([]);
		expect(out.content).toContain("done: false");
		expect(out.content).toContain("status: FAIL");
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

	test("does not ask parent to recover a repaired archive", () => {
		const out = composeAgentResult({ ...base, outputText: "rambled output, no marker" });
		expect(out.content).toContain("Do not read this file unless");
		expect(out.content).not.toContain("Use the read tool on that path");
	});

	test("keeps empty worker output blocked", () => {
		const composed = composeAgentResult({ ...base, outputText: "" });
		const handoff = compactHandoff({ ...base, composed });
		expect(handoff).toContain("RESULT contract missing");
		expect(handoff).toContain("/tmp/x.txt");
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

	test("PI_RESULT_CONTRACT_GATE=0 does not disable recovery", () => {
		process.env.PI_RESULT_CONTRACT_GATE = "0";
		try {
			expect(contractGateEnabled()).toBe(false);
			const out = composeAgentResult({ ...base, outputText: "no marker here" });
			expect(out.content.includes("⚠️")).toBe(false);
			expect(out.contractProblems).toEqual([]);
			expect(out.usedResult).toBe(true);
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
