// ABOUTME: Tests for reconcileJournal - closing journal rows orphaned when
// ABOUTME a parent pi process died mid-dispatch (firstmate-style restart-proofing).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { journalUpdate, reconcileJournal, type TaskJournalEntry } from "../lib/agent-task-journal.ts";

const RESULT = "## RESULT\nall good";
let dir: string;
let n = 0;

function baseRow(over: Partial<TaskJournalEntry>): TaskJournalEntry {
	n += 1;
	return {
		version: 1,
		id: `row-${n}`,
		kind: "team",
		agent: "builder",
		task: "t",
		status: "running",
		startedAt: Date.now() - 3600_000,
		updatedAt: Date.now() - 3500_000,
		...over,
	} as TaskJournalEntry;
}

function writeJournal(rows: unknown[]): void {
	writeFileSync(
		join(dir, "task-journal.jsonl"),
		rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
		"utf8",
	);
}
function readJournal(): string {
	return readFileSync(join(dir, "task-journal.jsonl"), "utf8");
}
function fakeSessionFile(withResult: boolean, staleMs: number): string {
	n += 1;
	const p = join(dir, `sess-${n}.jsonl`);
	const content = withResult
		? JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "x " + RESULT }] } }) + "\n"
		: JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "still working..." }] } }) + "\n";
	writeFileSync(p, content, "utf8");
	if (staleMs > 0) {
		const past = new Date(Date.now() - staleMs);
		utimesSync(p, past, past);
	}
	return p;
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "journal-reconcile-"));
	mkdirSync(join(dir, "outputs"), { recursive: true });
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("reconcileJournal", () => {
	it("flips rows whose persisted transcript already has a RESULT block to done", () => {
		const out = join(dir, "outputs", "done-run.txt");
		writeFileSync(out, RESULT + "\n## END\n", "utf8");
		const row = baseRow({ status: "running", outputFile: out });
		writeJournal([row]);
		reconcileJournal(dir);
		const e2 = JSON.parse(readJournal().split("\n")[0]);
		expect(e2.status).toBe("done");
		expect(e2.runStatus).toBe("succeeded");
		expect(e2.elapsedMs).toBeGreaterThan(0);
		expect(e2.note).toBeUndefined();
	});

	it("flips rows whose session ended with a RESULT message to done", () => {
		const sf = fakeSessionFile(true, 0);
		const row = baseRow({ sessionFile: sf });
		writeJournal([row]);
		reconcileJournal(dir);
		expect(readJournal()).toContain('"status":"done"');
	});

	it("leaves actively-written sessions and live pids untouched", () => {
		const freshSess = fakeSessionFile(false, 0);
		const rowA = baseRow({ id: "live-a-1", agent: "a", sessionFile: freshSess });
		const rowB = baseRow({ id: "live-b-1", agent: "b", pid: process.pid });
		writeJournal([rowA, rowB]);
		reconcileJournal(dir);
		const text = readJournal();
		expect(text).toContain('"status":"running"');
		expect(text).not.toContain("reconciled");
	});

	it("marks stale evidence-less rows as error with a reconciled note", () => {
		const staleSess = fakeSessionFile(false, 30 * 60_000);
		const rowA = baseRow({ id: "dead-a-1", agent: "a", sessionFile: staleSess });
		const rowB = baseRow({ id: "dead-b-1", agent: "b" });
		writeJournal([rowA, rowB]);
		reconcileJournal(dir);
		const lines = readJournal().trim().split("\n").map((l) => JSON.parse(l));
		const a = lines.find((e) => e.id === "dead-a-1");
		const b = lines.find((e) => e.id === "dead-b-1");
		expect(a?.status).toBe("error");
		expect(a?.runStatus).toBe("failed");
		expect(a?.elapsedMs).toBeGreaterThan(0);
		expect(a?.note).toContain("reconciled after restart");
		expect(b?.status).toBe("error");
		expect(b?.runStatus).toBe("failed");
	});

	it("never touches terminal or unparseable rows", () => {
		const doneRow = baseRow({ id: "was-done-1", agent: "a", status: "done", exitCode: 0 });
		writeJournal([doneRow, "{corrupt line"]);
		reconcileJournal(dir);
		const text = readJournal();
		expect(text).toContain("{corrupt line");
		const lines = text.trim().split("\n");
		expect(JSON.parse(lines[0]).status).toBe("done");
	});

	it("does not reopen a row with a canonical terminal status", () => {
		const cancelledRow = baseRow({ id: "canonical-cancelled-1", status: "running", runStatus: "cancelled" });
		writeJournal([cancelledRow]);
		reconcileJournal(dir);
		const updated = JSON.parse(readJournal().trim());
		expect(updated.status).toBe("running");
		expect(updated.runStatus).toBe("cancelled");
	});
});

describe("journalUpdate", () => {
	it("patches the last row with that id, not the first", () => {
		const oldRow = baseRow({ id: "omp-agent-sa1-1", status: "done", sessionFile: "/old.jsonl" });
		const newRow = baseRow({ id: "omp-agent-sa1-1", status: "dispatched" });
		writeJournal([oldRow, newRow]);
		journalUpdate(dir, "omp-agent-sa1-1", { status: "done", exitCode: 0, sessionFile: undefined });
		const lines = readJournal().trim().split("\n").map((l) => JSON.parse(l));
		expect(lines[0].sessionFile).toBe("/old.jsonl");
		expect(lines[0].status).toBe("done");
		expect(lines[1].status).toBe("done");
		expect(lines[1].exitCode).toBe(0);
		expect(lines[1].sessionFile).toBeUndefined();
	});

	it("preserves an explicit canonical cancellation status", () => {
		const row = baseRow({ id: "cancelled-1", status: "running" });
		writeJournal([row]);
		journalUpdate(dir, row.id, { status: "error", runStatus: "cancelled", exitCode: 130 });
		const updated = JSON.parse(readJournal().trim());
		expect(updated.status).toBe("error");
		expect(updated.runStatus).toBe("cancelled");
	});
});
