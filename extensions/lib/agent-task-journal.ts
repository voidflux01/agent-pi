// ABOUTME: Durable task journal for sub-agent dispatches (team/chain/pipeline).
// ABOUTME: Every dispatch appends a JSONL record; status changes rewrite the
// ABOUTME: matching line. The journal lives next to the agent session files and
// ABOUTME: survives parent restarts, so in-flight work stays visible and
// ABOUTME: resumable. Read-only by default: /agents-status shows the journal.
// ABOUTME: Never auto-restarts or auto-re-dispatches anything.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RESULT_MARKER } from "./agent-result-contract.ts";
import { readLastAssistantText } from "./herdr-client.ts";
import { isActiveRunStatus, isTerminalRunStatus, normalizeRunStatus, type RunStatus } from "./run-state.ts";

export type TaskJournalStatus = "dispatched" | "running" | "done" | "error";

export interface TaskJournalEntry {
	version: 1;
	/** Stable per-run id, matching the persisted output file base name. */
	id: string;
	kind: "team" | "chain" | "pipeline" | "sa";
	agent: string;
	/** External runtime label (e.g. "omp", "prime"); unset means pi. */
	runtime?: string;
	/** The dispatched task prompt (bounded for disk hygiene; never shown in context). */
	task: string;
	model?: string;
	/** Token/cost totals for the finished run (summed from the session file). */
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; costUsd: number };
	cwd?: string;
	/** Pi session file — enables `-c` resume after a parent restart. */
	sessionFile?: string;
	/** Full transcript path from the precision-preserving result contract. */
	outputFile?: string;
	/** Sub-agent process id, recorded at spawn. */
	pid?: number;
	status: TaskJournalStatus;
	/** Canonical status projection; legacy status remains for backward compatibility. */
	runStatus?: RunStatus;
	exitCode?: number | null;
	elapsedMs?: number;
	startedAt: number;
	updatedAt: number;
	/** True when this dispatch resumed an existing session (`-c`). */
	resumed?: boolean;
	/** Short human note, e.g. set when a crashed run was reconciled at startup. */
	note?: string;
}

export const JOURNAL_FILE = "task-journal.jsonl";
/** Task text kept in the journal (disk only) to keep the file lean. */
const MAX_TASK_CHARS = 4000;

export function journalPath(sessionDir: string): string {
	return join(sessionDir, JOURNAL_FILE);
}

/** A sub-agent session file not written for this long is considered idle/dead. */
export const RECONCILE_ACTIVE_WINDOW_MS = 5 * 60 * 1000;

const JOURNAL_LOCK_ATTEMPTS = 25;
const JOURNAL_LOCK_WAIT_MS = 20;
/** Only owner-less locks may use age-based recovery; PID-owned locks use liveness. */
const JOURNAL_OWNERLESS_LOCK_STALE_MS = 5_000;

function sleep(ms: number): void {
	try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

/** Serialize read-modify-write journal operations across Pi processes. */
function withJournalLock<T>(sessionDir: string, action: () => T): T | undefined {
	const lockPath = `${journalPath(sessionDir)}.lock`;
	let lockFd: number | undefined;
	try {
		mkdirSync(dirname(lockPath), { recursive: true });
		for (let attempt = 0; attempt < JOURNAL_LOCK_ATTEMPTS; attempt++) {
			try {
				lockFd = openSync(lockPath, "wx");
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
				try {
					const ownerText = readFileSync(lockPath, "utf8").trim();
					const owner = Number.parseInt(ownerText, 10);
					const ownerDead = Number.isInteger(owner) && owner > 0 && pidAlive(owner) === false;
					const ownerlessAndStale = !ownerText && Date.now() - statSync(lockPath).mtimeMs > JOURNAL_OWNERLESS_LOCK_STALE_MS;
					if (ownerDead || ownerlessAndStale) {
						unlinkSync(lockPath);
						continue;
					}
				} catch {}
				if (attempt === JOURNAL_LOCK_ATTEMPTS - 1) return undefined;
				sleep(JOURNAL_LOCK_WAIT_MS);
			}
		}
		if (lockFd === undefined) return undefined;
		try { writeFileSync(lockPath, String(process.pid), "utf8"); } catch { return undefined; }
		return action();
	} catch {
		return undefined;
	} finally {
		try { if (lockFd !== undefined) closeSync(lockFd); } catch {}
		try { if (lockFd !== undefined) unlinkSync(lockPath); } catch {}
	}
}

/**
 * Close out non-terminal journal rows left behind when a parent died
 * mid-dispatch. Called at session start / dispatch time next to
 * pruneRunArtifacts. Classification for each "dispatched"/"running" row:
 * - full transcript already on disk (output file or last assistant text)
 *   with a RESULT marker → done;
 * - headless run whose pid is still alive → untouched;
 * - session file still being written (mtime inside the active window) →
 *   untouched (a live sibling parent will update the row itself);
 * - anything else → error, marked as reconciled.
 */
function reconcileJournalUnlocked(sessionDir: string, activeWindowMs: number = RECONCILE_ACTIVE_WINDOW_MS): void {
	const p = journalPath(sessionDir);
	try {
		if (!existsSync(p)) return;
		const raw = readFileSync(p, "utf8");
		let changed = false;
		const kept: string[] = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) {
				continue;
			}
			let touchedLine = line;
			try {
				const e = JSON.parse(line) as TaskJournalEntry;
				if (isActiveRunStatus(e.runStatus || e.status) && typeof e.id === "string") {
					const done = classifyCrashedRun(sessionDir, e, activeWindowMs);
					if (done !== undefined) {
						e.status = done ? "done" : "error";
						e.runStatus = normalizeRunStatus(e.status);
						if (e.elapsedMs == null && Number.isFinite(e.startedAt)) {
							e.elapsedMs = Math.max(0, Date.now() - e.startedAt);
						}
						if (!done && e.exitCode == null) e.exitCode = null;
						if (!done) e.note = `reconciled after restart (${e.note ?? "no evidence of completion"})`;
						e.updatedAt = Date.now();
						touchedLine = JSON.stringify(e);
						changed = true;
					}
				}
			} catch {
				// unparseable line: preserve as-is
			}
			kept.push(touchedLine);
		}
		if (changed) {
			const tmp = p + ".tmp";
			writeFileSync(tmp, kept.length ? kept.join("\n") + "\n" : "", "utf8");
			renameSync(tmp, p);
		}
	} catch {}
}

export function reconcileJournal(sessionDir: string, activeWindowMs: number = RECONCILE_ACTIVE_WINDOW_MS): void {
	withJournalLock(sessionDir, () => reconcileJournalUnlocked(sessionDir, activeWindowMs));
}

/**
 * Evidence check for one in-flight row. Returns true (done), false
 * (presumed crashed → mark error), or undefined (leave the row alone).
 */
function classifyCrashedRun(
	sessionDir: string,
	e: TaskJournalEntry,
	activeWindowMs: number,
): boolean | undefined {
	// Strongest evidence: persisted full transcript ends with a RESULT block.
	if (e.outputFile) {
		try {
			const txt = readFileSync(e.outputFile, "utf8");
			if (txt.includes(RESULT_MARKER)) return true;
		} catch {}
	}
	// Next: the sub-agent's own session ended with a RESULT message.
	if (e.sessionFile) {
		try {
			const st = statSync(e.sessionFile);
			const last = readLastAssistantText(e.sessionFile);
			if (last.found && last.text.includes(RESULT_MARKER)) return true;
			if (Date.now() - st.mtimeMs < activeWindowMs) return undefined; // actively writing
		} catch {
			// session file missing/unreadable → fall through to pid/staleness
		}
	}
	// A live pid means the headless fallback is genuinely still running.
	if (pidAlive(e.pid) === true) return undefined;
	return false;
}

/** Retention window for run artifacts (archive .txt files + journal rows). */
export const RUN_ARTIFACT_RETENTION_DAYS = 7;

/**
 * Prune run artifacts older than `maxDays` from a session directory:
 * - removes `outputs/*.txt` transcripts past the cutoff;
 * - rewrites `task-journal.jsonl` dropping entries whose last update is
 *   past the cutoff (corrupt lines are preserved as-is).
 * Called at session start by the team/chain/pipeline/subagent entry
 * points. Silent on any filesystem error — cleanup must never break
 * startup or lose fresh data.
 */
export function pruneRunArtifacts(sessionDir: string, maxDays: number = RUN_ARTIFACT_RETENTION_DAYS): void {
	const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;

	// 1) Archive transcripts
	try {
		const outputsDir = join(sessionDir, "outputs");
		for (const name of readdirSync(outputsDir)) {
			if (!name.endsWith(".txt")) continue;
			const filePath = join(outputsDir, name);
			try {
				if (statSync(filePath).mtimeMs < cutoff) unlinkSync(filePath);
			} catch {}
		}
	} catch {}

	// 2) Journal rows (temp file + rename so a crash mid-write cannot
	//    truncate the journal)
	withJournalLock(sessionDir, () => {
		try {
			const p = journalPath(sessionDir);
			if (existsSync(p)) {
				const raw = readFileSync(p, "utf8");
				const kept: string[] = [];
				for (const line of raw.split("\n")) {
					if (!line.trim()) continue;
					try {
						const e = JSON.parse(line) as { updatedAt?: number; startedAt?: number };
						const ts = e.updatedAt ?? e.startedAt ?? 0;
						if (ts >= cutoff) kept.push(line);
					} catch {
						kept.push(line); // preserve unrecognized data
					}
				}
				const tmp = p + ".tmp";
				writeFileSync(tmp, kept.length ? kept.join("\n") + "\n" : "", "utf8");
				renameSync(tmp, p);
			}
		} catch {}
	});
}

/** Append a new dispatch record. */
function journalAppendUnlocked(sessionDir: string, entry: TaskJournalEntry): void {
	const p = journalPath(sessionDir);
	try {
		mkdirSync(dirname(p), { recursive: true });
	} catch {}
	try {
		const task = entry.task.length > MAX_TASK_CHARS
			? entry.task.slice(0, MAX_TASK_CHARS) + "\n...[truncated]"
			: entry.task;
		appendFileSync(p, JSON.stringify({ ...entry, task, runStatus: normalizeRunStatus(entry.runStatus || entry.status) }) + "\n", "utf8");
	} catch {}
}

export function journalAppend(sessionDir: string, entry: TaskJournalEntry): void {
	withJournalLock(sessionDir, () => journalAppendUnlocked(sessionDir, entry));
}

/** Update the record with the given id (last match wins). Never fabricates. */
function journalUpdateUnlocked(sessionDir: string, id: string, patch: Partial<TaskJournalEntry>): void {
	const p = journalPath(sessionDir);
	if (!existsSync(p)) return;
	let lines: string[];
	try {
		lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
	} catch {
		return;
	}
	let last = -1;
	const parsed: Array<TaskJournalEntry | null> = [];
	for (const line of lines) {
		try {
			const e = JSON.parse(line) as TaskJournalEntry;
			parsed.push(e);
			if (e.id === id) last = parsed.length - 1;
		} catch {
			parsed.push(null);
		}
	}
	if (last < 0) return;
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (i === last && parsed[i]) {
			const next = { ...parsed[i], ...patch, id, updatedAt: Date.now() };
			if (patch.runStatus !== undefined) next.runStatus = normalizeRunStatus(patch.runStatus);
			else if (patch.status !== undefined) next.runStatus = normalizeRunStatus(patch.status);
			else if (!next.runStatus) next.runStatus = normalizeRunStatus(next.status);
			out.push(JSON.stringify(next) + "\n");
		} else {
			out.push(lines[i] + "\n");
		}
	}
	try {
		const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
		try {
			writeFileSync(tmp, out.join(""), "utf8");
			renameSync(tmp, p);
		} finally {
			try {
				if (existsSync(tmp)) unlinkSync(tmp);
			} catch {}
		}
	} catch {}
}

export function journalUpdate(sessionDir: string, id: string, patch: Partial<TaskJournalEntry>): void {
	withJournalLock(sessionDir, () => journalUpdateUnlocked(sessionDir, id, patch));
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
				const entry = JSON.parse(line) as TaskJournalEntry;
				if (!entry.runStatus) entry.runStatus = normalizeRunStatus(entry.status);
				entries.push(entry);
			} catch {}
		}
	} catch {}
	return entries;
}

/** Records that are dispatched or running (candidate in-flight work). */
export function journalActive(sessionDir: string): TaskJournalEntry[] {
	return journalList(sessionDir).filter(
		(e) => isActiveRunStatus(e.runStatus || e.status),
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
	const normalizedStatus = normalizeRunStatus(e.runStatus || e.status);
	const legacyStatus = typeof e.status === "string" ? e.status : "unknown";
	const statusLabel = normalizedStatus === "unknown" ? legacyStatus : normalizedStatus;
	const alive = typeof e.pid === "number" && e.pid > 0
		? (pidAlive(e.pid) === true ? " pid:alive" : pidAlive(e.pid) === false ? " pid:dead" : " pid:?")
		: "";
	const elapsed = e.elapsedMs != null ? ` ${Math.round(e.elapsedMs / 1000)}s` : "";
	const session = e.sessionFile ? ` session:${e.sessionFile}` : "";
	const resumed = e.resumed ? " (resumed)" : "";
	const note = e.note ? ` [${e.note}]` : "";
	let usage = "";
	if (e.usage && e.usage.totalTokens > 0) {
		const u = e.usage;
		const cost = u.costUsd > 0 ? `$${u.costUsd < 0.01 ? u.costUsd.toFixed(4) : u.costUsd.toFixed(2)}` : "$0";
		const cachePct = u.input + u.cacheRead > 0 ? Math.round((u.cacheRead / (u.input + u.cacheRead)) * 100) : 0;
		usage = ` ${u.totalTokens.toLocaleString()}tok (${cachePct}% cached) ${cost}`;
	}
	const runtime = e.runtime ? ` [${e.runtime}]` : "";
	return `${statusLabel.toUpperCase().padEnd(10)} ${e.id}${runtime}${alive}${elapsed}${usage}${resumed}${session}${note}`;
}

/** Aggregate usage across finished rows — the fleet total under /agents-status. */
export function sumJournalUsage(entries: TaskJournalEntry[]): { totalTokens: number; costUsd: number; runs: number } {
	const acc = { totalTokens: 0, costUsd: 0, runs: 0 };
	for (const e of entries) {
		const totalTokens = e.usage?.totalTokens;
		if (!Number.isFinite(totalTokens) || totalTokens <= 0) continue;
		acc.totalTokens += totalTokens;
		acc.costUsd += Number.isFinite(e.usage?.costUsd) ? (e.usage?.costUsd ?? 0) : 0;
		acc.runs += 1;
	}
	return acc;
}

export interface JournalSummary {
	totalRuns: number;
	activeRuns: number;
	succeededRuns: number;
	failedRuns: number;
	cancelledRuns: number;
	resumedRuns: number;
	totalElapsedMs: number;
	totalTokens: number;
	costUsd: number;
	byKind: Record<TaskJournalEntry["kind"], { runs: number; succeeded: number; failed: number; elapsedMs: number; totalTokens: number; costUsd: number }>;
}

/** Aggregate lifecycle, timing, and usage metrics without changing journal rows. */
export function summarizeJournal(entries: TaskJournalEntry[]): JournalSummary {
	const byKind = {} as JournalSummary["byKind"];
	const summary: JournalSummary = {
		totalRuns: entries.length,
		activeRuns: 0,
		succeededRuns: 0,
		failedRuns: 0,
		cancelledRuns: 0,
		resumedRuns: entries.filter((entry) => entry.resumed === true).length,
		totalElapsedMs: 0,
		totalTokens: 0,
		costUsd: 0,
		byKind,
	};
	for (const entry of entries) {
		const status = normalizeRunStatus(entry.runStatus || entry.status);
		if (isActiveRunStatus(status)) summary.activeRuns += 1;
		if (status === "succeeded") summary.succeededRuns += 1;
		if (status === "failed") summary.failedRuns += 1;
		if (status === "cancelled") summary.cancelledRuns += 1;
		const elapsedMs = Number.isFinite(entry.elapsedMs) && (entry.elapsedMs ?? 0) > 0 ? entry.elapsedMs ?? 0 : 0;
		const totalTokens = Number.isFinite(entry.usage?.totalTokens) && (entry.usage?.totalTokens ?? 0) > 0 ? entry.usage?.totalTokens ?? 0 : 0;
		const costUsd = Number.isFinite(entry.usage?.costUsd) && (entry.usage?.costUsd ?? 0) > 0 ? entry.usage?.costUsd ?? 0 : 0;
		summary.totalElapsedMs += elapsedMs;
		summary.totalTokens += totalTokens;
		summary.costUsd += costUsd;
		const kind = entry.kind;
		const bucket = byKind[kind] || (byKind[kind] = { runs: 0, succeeded: 0, failed: 0, elapsedMs: 0, totalTokens: 0, costUsd: 0 });
		bucket.runs += 1;
		if (status === "succeeded") bucket.succeeded += 1;
		if (status === "failed") bucket.failed += 1;
		bucket.elapsedMs += elapsedMs;
		bucket.totalTokens += totalTokens;
		bucket.costUsd += costUsd;
	}
	return summary;
}

export function formatJournalSummary(summary: JournalSummary): string {
	const elapsed = `${Math.round(summary.totalElapsedMs / 1000)}s`;
	const cost = summary.costUsd > 0
		? `$${summary.costUsd < 0.01 ? summary.costUsd.toFixed(4) : summary.costUsd.toFixed(2)}`
		: "$0";
	return `TOTAL: ${summary.totalRuns} runs | ${summary.succeededRuns} succeeded | ${summary.failedRuns} failed | ${summary.cancelledRuns} cancelled | ${summary.activeRuns} active | ${summary.resumedRuns} resumed | ${elapsed} elapsed | ${summary.totalTokens.toLocaleString()} tokens | ${cost}`;
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
			const recent = all.filter((e) => isTerminalRunStatus(e.runStatus || e.status)).slice(-10);
			const lines: string[] = [];
			if (active.length > 0) {
				lines.push("IN-FLIGHT:");
				for (const e of active) lines.push("  " + formatJournalEntry(e));
			} else {
				lines.push("IN-FLIGHT: none");
			}
			lines.push(formatJournalSummary(summarizeJournal(all)));
			if (recent.length > 0) {
				lines.push("RECENT:");
				for (const e of recent) lines.push("  " + formatJournalEntry(e));
				const totals = sumJournalUsage(recent);
				if (totals.runs > 0) {
					const cost = totals.costUsd > 0 ? `$${totals.costUsd < 0.01 ? totals.costUsd.toFixed(4) : totals.costUsd.toFixed(2)}` : "$0";
					lines.push(`  TOTAL (${totals.runs} runs): ${totals.totalTokens.toLocaleString()} tokens, ${cost}`);
				}
			}
			lines.push("Journal: " + journalPath(dir));
			ctx?.ui?.notify?.(lines.join("\n"), "info");
		},
	});
}
