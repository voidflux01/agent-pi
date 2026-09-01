import { describe, expect, test } from "bun:test";
import { readLastAssistantText, sessionUsage } from "../lib/herdr-client.ts";
import { formatJournalEntry, sumJournalUsage, summarizeJournal, type TaskJournalEntry } from "../lib/agent-task-journal.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeSession(messages: any[]): string {
	const dir = mkdtempSync(join(tmpdir(), "usage-test-"));
	const p = join(dir, "s.jsonl");
	writeFileSync(p, messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
	return p;
}

const u = (input: number, output: number, cacheRead = 0, costTotal?: number) => ({
	role: "assistant",
	content: [{ type: "text", text: "ok" }],
	usage: { input, output, cacheRead, totalTokens: input + output + cacheRead, cost: { total: costTotal ?? 0 } },
});

describe("sessionUsage", () => {
	test("sums assistant-message usage and skips other roles", () => {
		const p = makeSession([
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			u(1000, 100, 50, 0.01),
			u(2000, 200, 0, 0.02),
			{ message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 0, cost: { total: 0.0001 } }, content: [] } },
		]);
		const s = sessionUsage(p);
		expect(s.input).toBe(3010);
		expect(s.output).toBe(305);
		expect(s.cacheRead).toBe(50);
		expect(s.totalTokens).toBe(3365);
		expect(Math.abs(s.costUsd - 0.0301) < 1e-9).toBe(true);
		expect(s.assistantMessages).toBe(3);
	});

	test("missing file => zeros", () => {
		const s = sessionUsage("/nonexistent/file.jsonl");
		expect(s.assistantMessages).toBe(0);
		expect(s.costUsd).toBe(0);
	});

	test("file without usage lines => zeros, no crash", () => {
		const p = makeSession([{ role: "assistant", content: [{ type: "text", text: "no usage here" }] }]);
		const s = sessionUsage(p);
		expect(s.assistantMessages).toBe(0);
	});
});

describe("live session text reading", () => {
	test("reads the newest assistant line without scanning the whole transcript", () => {
		const p = makeSession([
			...Array.from({ length: 5000 }, (_, i) => ({ role: "user", content: [{ type: "text", text: `padding-${i}-` + "x".repeat(100) }] })),
			{ role: "assistant", content: [{ type: "text", text: "latest progress" }] },
		]);
		expect(readLastAssistantText(p)).toEqual({ text: "latest progress", found: true });
	});
});

describe("journal usage rendering", () => {
	const base: TaskJournalEntry = {
		version: 1, id: "tester-1", kind: "team", agent: "tester", task: "x",
		status: "done", startedAt: 0, updatedAt: 0,
	};

	test("entry with usage renders tokens + cache% + cost", () => {
		const line = formatJournalEntry({ ...base, usage: { input: 300, output: 100, cacheRead: 600, cacheWrite: 0, totalTokens: 12000, costUsd: 0.0042 } });
		expect(line.includes("12,000tok")).toBe(true);
		expect(line.includes("(67% cached)")).toBe(true);
		expect(line.includes("$0.0042")).toBe(true);
	});

	test("entry without usage renders no token text", () => {
		expect(formatJournalEntry(base).includes("tok")).toBe(false);
	});

	test("sumJournalUsage aggregates runs with usage only", () => {
		const sums = sumJournalUsage([
			{ ...base, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 100, costUsd: 0.01 } },
			base,
			{ ...base, id: "tester-2", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 250, costUsd: 0.02 } },
		]);
		expect(sums.runs).toBe(2);
		expect(sums.totalTokens).toBe(350);
		expect(Math.abs(sums.costUsd - 0.03) < 1e-9).toBe(true);
	});

	test("summarizeJournal aggregates lifecycle, timing, usage, and resumed runs", () => {
		const summary = summarizeJournal([
			{ ...base, status: "done", kind: "team", elapsedMs: 1500, resumed: true, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 100, costUsd: 0.01 } },
			{ ...base, id: "chain-1", status: "error", kind: "chain", elapsedMs: 2500, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 200, costUsd: 0.02 } },
			{ ...base, id: "pipeline-1", status: "running", kind: "pipeline", elapsedMs: 500 },
		]);
		expect(summary.totalRuns).toBe(3);
		expect(summary.succeededRuns).toBe(1);
		expect(summary.failedRuns).toBe(1);
		expect(summary.activeRuns).toBe(1);
		expect(summary.resumedRuns).toBe(1);
		expect(summary.totalElapsedMs).toBe(4500);
		expect(summary.totalTokens).toBe(300);
		expect(summary.byKind.chain.failed).toBe(1);
	});

	test("ignores non-finite journal metrics", () => {
		const malformed = {
			...base,
			elapsedMs: Number.POSITIVE_INFINITY,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: Number.NaN, costUsd: Number.NaN },
		};
		const summary = summarizeJournal([malformed]);
		expect(summary.totalElapsedMs).toBe(0);
		expect(summary.totalTokens).toBe(0);
		expect(summary.costUsd).toBe(0);
		expect(sumJournalUsage([malformed]).runs).toBe(0);
	});

	test("summary rendering includes cancelled runs", () => {
		const summary = summarizeJournal([{ ...base, status: "done", runStatus: "cancelled" }]);
		expect(summary.cancelledRuns).toBe(1);
		expect(formatJournalEntry({ ...base, status: "done", runStatus: "cancelled" })).toContain("CANCELLED");
	});
});
