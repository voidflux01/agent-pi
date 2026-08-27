// ABOUTME: Durable task journal for sub-agent dispatches (team/chain/pipeline).
// ABOUTME: Every dispatch appends a JSONL record; status changes rewrite the
// ABOUTME: matching line. The journal lives next to the agent session files and
// ABOUTME: survives parent restarts, so in-flight work stays visible and
// ABOUTME: resumable. Read-only by default: /agents-status shows the journal.
// ABOUTME: Never auto-restarts or auto-re-dispatches anything.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type TaskJournalStatus = "dispatched" | "running" | "done" | "error";

export interface TaskJournalEntry {
	version: 1;
	/** Stable per-run id, matching the persisted output file base name. */
	id: string;
	kind: "team" | "chain" | "pipeline";
	agent: string;
	/** The dispatched task prompt (bounded for disk hygiene; never shown in context). */
	task: string;
	model?: string;
	cwd?: string;
	/** Pi session file — enables `-c` resume after a parent restart. */
	sessionFile?: string;
	/** Full transcript path from the precision-preserving result contract. */
	outputFile?: string;
	/** Sub-agent process id, recorded at spawn. */
	pid?: number;
	status: TaskJournalStatus;
	exitCode?: number | null;
	elapsedMs?: number;
	startedAt: number;
	updatedAt: number;
	/** True when this dispatch resumed an existing session (`-c`). */
	resumed?: boolean;
}

export const JOURNAL_FILE = "task-journal.jsonl";
/** Task text kept in the journal (disk only) to keep the file lean. */
const MAX_TASK_CHARS = 4000;

export function journalPath(sessionDir: string): string {
	return join(sessionDir, JOURNAL_FILE);
}

/** Append a new dispatch record. */
export function journalAppend(sessionDir: string, entry: TaskJournalEntry): void {
	const p = journalPath(sessionDir);
	try {
		mkdirSync(dirname(p), { recursive: true });
	} catch {}
	try {
		const task = entry.task.length > MAX_TASK_CHARS
			? entry.task.slice(0, MAX_TASK_CHARS) + "\n...[truncated]"
			: entry.task;
		appendFileSync(p, JSON.stringify({ ...entry, task }) + "\n", "utf8");
	} catch {}
}

/** Update the record with the given id (first match wins). Never fabricates. */
export function journalUpdate(sessionDir: string, id: string, patch: Partial<TaskJournalEntry>): void {
	const p = journalPath(sessionDir);
	if (!existsSync(p)) return;
	let lines: string[];
	try {
		lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
	} catch {
		return;
	}
	const out: string[] = [];
	let found = false;
	for (const line of lines) {
		try {
			const e = JSON.parse(line) as TaskJournalEntry;
			if (!found && e.id === id) {
				found = true;
				out.push(JSON.stringify({ ...e, ...patch, id, updatedAt: Date.now() }) + "\n");
			} else {
				out.push(line + "\n");
			}
		} catch {
			out.push(line + "\n");
		}
	}
	if (!found) return;
	try {
		writeFileSync(p, out.join(""), "utf8");
	} catch {}
}

/** Read all journal records, oldest first. Corrupt lines are skipped. */
export function journalList(sessionDir: string): TaskJournalEntry[] {
	const p = journalPath(sessionDir);
	if (!existsSync(p)) return [];
	const entries: TaskJournalEntry[] = [];
	try {
		for (const line of readFileSync(p, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				entries.push(JSON.parse(line));
			} catch {}
		}
	} catch {}
	return entries;
}

/** Records that are dispatched or running (candidate in-flight work). */
export function journalActive(sessionDir: string): TaskJournalEntry[] {
	return journalList(sessionDir).filter(
		(e) => e.status === "dispatched" || e.status === "running",
	);
}

/** Best-effort liveness: true=alive, false=dead, undefined=unknown. */
export function pidAlive(pid: number | undefined): boolean | undefined {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: any) {
		if (err?.code === "ESRCH") return false;
		if (err?.code === "EPERM") return true;
		return undefined;
	}
}

/** One-line human-readable rendering of a journal record. */
export function formatJournalEntry(e: TaskJournalEntry): string {
	const alive = typeof e.pid === "number" && e.pid > 0
		? (pidAlive(e.pid) === true ? " pid:alive" : pidAlive(e.pid) === false ? " pid:dead" : " pid:?")
		: "";
	const elapsed = e.elapsedMs != null ? ` ${Math.round(e.elapsedMs / 1000)}s` : "";
	const session = e.sessionFile ? ` session:${e.sessionFile}` : "";
	const resumed = e.resumed ? " (resumed)" : "";
	return `${e.status.toUpperCase().padEnd(10)} ${e.id}${alive}${elapsed}${resumed}${session}`;
}

/**
 * Register the shared /agents-status command. Safe to call from every
 * orchestration extension: only the first registration wins.
 */
export function registerTaskStatusCommand(pi: any, sessionDir: () => string): void {
	const g = globalThis as any;
	if (g.__piTaskStatusRegistered) return;
	g.__piTaskStatusRegistered = true;

	pi.registerCommand("agents-status", {
		description: "Show the durable task journal — in-flight and recent sub-agent dispatches (survives restarts)",
		handler: async (_args: string, ctx: any) => {
			const dir = sessionDir();
			if (!dir) {
				ctx?.ui?.notify?.("No session directory yet", "info");
				return;
			}
			const active = journalActive(dir);
			const all = journalList(dir);
			const recent = all.filter((e) => e.status === "done" || e.status === "error").slice(-10);
			const lines: string[] = [];
			if (active.length > 0) {
				lines.push("IN-FLIGHT:");
				for (const e of active) lines.push("  " + formatJournalEntry(e));
			} else {
				lines.push("IN-FLIGHT: none");
			}
			if (recent.length > 0) {
				lines.push("RECENT:");
				for (const e of recent) lines.push("  " + formatJournalEntry(e));
			}
			lines.push("Journal: " + journalPath(dir));
			ctx?.ui?.notify?.(lines.join("\n"), "info");
		},
	});
}
