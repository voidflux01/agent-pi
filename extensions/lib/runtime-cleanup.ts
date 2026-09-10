// ABOUTME: Bounded cleanup of workspace runtime artifacts. Two complementary
// ABOUTME: passes: an mtime-based retention sweep (session start, 7 days over a
// ABOUTME: fixed path table) and an immediate pass for provably-dead artifacts
// ABOUTME: (session shutdown: verifier transcripts, terminal orchestration runs).

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
export const RUNTIME_ARTIFACT_RETENTION_MS = 7 * DAY_MS;

/** Minimum gap between full retention sweeps. The sweep walks the whole
 *  artifact table (often thousands of files), so running it on every session
 *  start is wasted work — once per 12h is plenty for a 7-day window. */
export const RUNTIME_CLEANUP_THROTTLE_MS = 12 * 60 * 60 * 1000;

/** Marker recording the last full sweep; kept in .pi (already out of the
 *  workspace manifest, so cleanup never disturbs receipt bindings). */
export const LAST_SWEEP_MARKER = join(".pi", "runtime-cleanup.last");

/** Marker an orchestration run writes at creation and removes when it reaches
 *  a terminal state (finish). A composition dir without it is a finished run. */
export const ACTIVE_RUN_MARKER = "active.json";

/** Repo-relative paths swept recursively by file mtime. State that is user
 *  data or long-lived by design is intentionally absent: .pi/workflow
 *  (approvals/memory/retrospectives), .context/todo.md & session-state.json
 *  (task list), .context/reports (own pruner), chain/team durable snapshots. */
export const RUNTIME_ARTIFACT_DIRS = [
	".pi/agent-sessions/compositions",
	".pi/agent-sessions/verifier",
	".pi/agent-sessions/dispatch-receipts",
	".pi/debug-captures",
	".pi/web-test-captures",
	".pi/grill-me",
	".context/evidence",
	".context/research-sessions",
	".context/generated-images",
	".pi/security-audit.log",
];

/** Pure capture artifacts with no recovery or audit value: screenshots and
 *  grill bookkeeping. Safe to delete whole-sale at session shutdown, so they
 *  are excluded from the retention sweep above (which is the crash-debris net). */
export const SESSION_SCRAP_DIRS = [
	".pi/debug-captures",
	".pi/web-test-captures",
	".pi/grill-me",
];

/** Subagent worker sessions live under the user's home dir (not the workspace):
 *  their per-tool compositions land in ~/.pi/agent/sessions/subagents/compositions.
 *  Worker exit must NOT clean these (the parent may still want the ledger); the
 *  parent session's shutdown reaps them via cleanupTerminalRuns, and the home
 *  sessions dir is swept on retention as the crash-debris net. */
export const HOME_SUBAGENT_SESSIONS = join(homedir(), ".pi", "agent", "sessions", "subagents");
export const HOME_SUBAGENT_COMPOSITIONS = join(HOME_SUBAGENT_SESSIONS, "compositions");

/** Recursively delete files older than `cutoff`, then remove dirs left empty.
 *  Silent on any filesystem error — cleanup must never break anything. */
function sweep(path: string, cutoff: number): number {
	let stat: ReturnType<typeof lstatSync>;
	try { stat = lstatSync(path); } catch { return 0; }
	if (stat.isSymbolicLink() || stat.isFile()) {
		if (stat.mtimeMs < cutoff) { try { unlinkSync(path); return 1; } catch { return 0; } }
		return 0;
	}
	let removed = 0;
	for (const name of readdirSync(path)) removed += sweep(join(path, name), cutoff);
	// rmdirSync: only reap directories we just emptied — never force through one
	// that gained entries mid-walk (and rmSync without recursive rejects dirs).
	if (readdirSync(path).length === 0) { try { rmdirSync(path); removed++; } catch { } }
	return removed;
}

/** Retention sweep over the fixed artifact table, throttled: skips (and keeps
 *  the old marker) when the last sweep is younger than `throttleMs`. */
export function cleanupRuntimeArtifacts(cwd: string, retentionMs = RUNTIME_ARTIFACT_RETENTION_MS, throttleMs = RUNTIME_CLEANUP_THROTTLE_MS, homeDirs: string[] = [HOME_SUBAGENT_SESSIONS]): number {
	const markerPath = join(cwd, LAST_SWEEP_MARKER);
	let last = 0;
	try { last = Number(readFileSync(markerPath, "utf8")) || 0; } catch { }
	if (throttleMs > 0 && last > 0 && Date.now() - last < throttleMs) return 0;
	const cutoff = Date.now() - retentionMs;
	let removed = 0;
	for (const rel of RUNTIME_ARTIFACT_DIRS) {
		try { removed += sweep(join(cwd, rel), cutoff); } catch { }
	}
	for (const abs of homeDirs) {
		try { removed += sweep(abs, cutoff); } catch { }
	}
	try { mkdirSync(dirname(markerPath), { recursive: true }); writeFileSync(markerPath, String(Date.now())); } catch { }
	return removed;
}

/** Delete session-scrap directories entirely (captures, grill bookkeeping). */
export function cleanupSessionScrap(cwd: string): number {
	let removed = 0;
	for (const rel of SESSION_SCRAP_DIRS) {
		try { rmSync(join(cwd, rel), { recursive: true, force: true }); removed++; } catch { }
	}
	return removed;
}

/** Delete verifier session transcripts. Safe unconditionally: the verdict lives
 *  in the persisted receipt; the raw transcript is only parsed during the run. */
export function cleanupVerifierTranscripts(cwd: string): number {
	const dir = join(cwd, ".pi", "agent-sessions", "verifier");
	let names: string[];
	try { names = readdirSync(dir); } catch { return 0; }
	let removed = 0;
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		try { unlinkSync(join(dir, name)); removed++; } catch { }
	}
	return removed;
}

/** Delete orchestration runs that reached a terminal state (no active.json).
 *  Covers the workspace's top-level compositions dir plus per-session nested
 *  ones (event dirs land under the session file's dir, e.g. verifier/compositions),
 *  and the home subagent compositions dir (subagent worker ledgers).
 *  Runs mid-flight are kept: their subagent may still be running in a detached
 *  pane, or be resumed after a crash via dispatch receipts. */
export function cleanupTerminalRuns(cwd: string, homeCompositions: string = HOME_SUBAGENT_COMPOSITIONS): number {
	// Home subagent ledger is swept regardless of the workspace layout: a fresh
	// workspace may have no .pi/agent-sessions at all while workers still left runs.
	let removed = reapTerminalRuns(homeCompositions);
	const sessions = join(cwd, ".pi", "agent-sessions");
	let names: string[];
	try { names = readdirSync(sessions); } catch { return removed; }
	for (const name of names) {
		const base = name === "compositions"
			? join(sessions, name)
			: join(sessions, name, "compositions");
		removed += reapTerminalRuns(base);
	}
	return removed;
}

/** Remove finished run dirs (no active.json) under one compositions base. */
function reapTerminalRuns(base: string): number {
	let runDirs: string[];
	try { runDirs = readdirSync(base); } catch { return 0; }
	let removed = 0;
	for (const runId of runDirs) {
		const dir = join(base, runId);
		try {
			if (!existsSync(join(dir, ACTIVE_RUN_MARKER))) {
				rmSync(dir, { recursive: true, force: true });
				removed++;
			}
		} catch { }
	}
	return removed;
}
