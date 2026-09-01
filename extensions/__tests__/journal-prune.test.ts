// ABOUTME: Tests for pruneRunArtifacts - 7-day rolling retention for
// ABOUTME archived transcripts (.pi/agent-sessions/outputs) and journal rows.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { journalAppend, pruneRunArtifacts } from "../lib/agent-task-journal.ts";

const DAY = 24 * 60 * 60 * 1000;
let dir: string;

function readJournal(): string {
	const p = join(dir, "task-journal.jsonl");
	return existsSync(p) ? readFileSync(p, "utf8") : "";
}
function writeJournalLine(obj: unknown): void {
	writeFileSync(join(dir, "task-journal.jsonl"), readJournal() + JSON.stringify(obj) + "\n", "utf8");
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "journal-prune-"));
	mkdirSync(join(dir, "outputs"), { recursive: true });
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("pruneRunArtifacts", () => {
	it("removes .txt past the cutoff, keeps fresh ones and non-txt files", () => {
		const outputs = join(dir, "outputs");
		writeFileSync(join(outputs, "old.txt"), "old");
		utimesSync(join(outputs, "old.txt"), new Date(Date.now() - 40 * DAY), new Date(Date.now() - 40 * DAY));
		writeFileSync(join(outputs, "fresh.txt"), "fresh");
		writeFileSync(join(outputs, "meta.json"), "{}");
		pruneRunArtifacts(dir, 30);
		expect(existsSync(join(outputs, "old.txt"))).toBe(false);
		expect(existsSync(join(outputs, "fresh.txt"))).toBe(true);
		expect(existsSync(join(outputs, "meta.json"))).toBe(true);
	});

	it("drops stale journal rows but preserves recent ones and corrupt lines", () => {
		writeJournalLine({ id: "a-1", status: "done", updatedAt: Date.now() });
		writeJournalLine({ id: "b-1", status: "error", updatedAt: Date.now() - 45 * DAY });
		writeJournalLine({ id: "c-1", status: "running", startedAt: Date.now() - 45 * DAY });
		writeJournalLine({ id: "d-1", status: "done", updatedAt: Date.now() - 10 * DAY });
		writeFileSync(join(dir, "task-journal.jsonl"), readJournal() + "not-json-garbage\n", "utf8");

		pruneRunArtifacts(dir, 30);

		const text = readJournal();
		expect(text).toContain('"a-1"');
		expect(text).toContain('"d-1"');
		expect(text).toContain("not-json-garbage");
		expect(text).not.toContain('"b-1"');
		expect(text).not.toContain('"c-1"');
	});

	it("default retention is 7 days", () => {
		const outputs = join(dir, "outputs");
		const borderline = join(outputs, "eight-days.txt");
		writeFileSync(borderline, "x");
		utimesSync(borderline, new Date(Date.now() - 8 * DAY), new Date(Date.now() - 8 * DAY));
		writeJournalLine({ id: "e-1", status: "done", updatedAt: Date.now() - 8 * DAY });

		pruneRunArtifacts(dir); // no explicit maxDays

		expect(existsSync(borderline)).toBe(false);
		expect(readJournal()).not.toContain('"e-1"');
	});

	it("never throws on missing directories or journal", () => {
		const empty = join(tmpdir(), "journal-prune-empty-" + Math.random().toString(36).slice(2));
		mkdirSync(empty, { recursive: true });
		expect(() => pruneRunArtifacts(empty)).not.toThrow();
		rmSync(empty, { recursive: true, force: true });
	});

	it("recovers a lock left by a dead process", () => {
		const lockPath = join(dir, "task-journal.jsonl.lock");
		writeFileSync(lockPath, "99999999", "utf8");
		journalAppend(dir, {
			version: 1, id: "after-crash", kind: "team", agent: "builder", task: "task",
			status: "done", startedAt: Date.now(), updatedAt: Date.now(),
		});
		expect(readJournal()).toContain('"after-crash"');
		expect(existsSync(lockPath)).toBe(false);
	});

	it("recovers an owner-less lock left during acquisition", () => {
		const lockPath = join(dir, "task-journal.jsonl.lock");
		writeFileSync(lockPath, "", "utf8");
		const stale = new Date(Date.now() - 10_000);
		utimesSync(lockPath, stale, stale);
		journalAppend(dir, {
			version: 1, id: "after-ownerless-crash", kind: "team", agent: "builder", task: "task",
			status: "done", startedAt: Date.now(), updatedAt: Date.now(),
		});
		expect(readJournal()).toContain('"after-ownerless-crash"');
		expect(existsSync(lockPath)).toBe(false);
	});
});
