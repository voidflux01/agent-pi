// ABOUTME: Bounded cleanup of workspace runtime artifacts. Two complementary
// ABOUTME: passes: an mtime-based retention sweep (session start, 7 days over a
// ABOUTME: fixed path table) and an immediate pass for provably-dead artifacts
// ABOUTME: (session shutdown: verifier transcripts, terminal orchestration runs).

import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
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

/** Repo-relative paths swept recursively by file mtime. State that is user
 *  data or long-lived by design is intentionally absent: .pi/workflow
 *  (approvals/memory/retrospectives), .context/todo.md & session-state.json
 *  (task list), .context/reports (own pruner), chain/team durable snapshots.
 *  The on-disk orchestration composition ledger was removed, so there is no
 *  longer a `.pi/agent-sessions/compositions` entry (or nested per-session
 *  ones) to sweep. */
export const RUNTIME_ARTIFACT_DIRS = [
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
 *  their transcripts are swept on retention as the crash-debris net. The
 *  on-disk orchestration ledger was removed, so nothing new lands under
 *  `subagents/compositions`; any legacy dirs there are covered by the same
 *  recursive sweep on the sessions dir. */
export const HOME_SUBAGENT_SESSIONS = join(homedir(), ".pi", "agent", "sessions", "subagents");

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
