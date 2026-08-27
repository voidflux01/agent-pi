// ABOUTME: Herdr transport for sub-agent dispatch (team mode, Phase 1).
// ABOUTME: When the parent runs inside Herdr (HERDR_ENV=1) and a server is
// ABOUTME: reachable, sub-agents run as headless `pi --mode json` inside a
// ABOUTME: Herdr pane: visible, persistent across parent restarts, and
// ABOUTME: resumable. When Herdr is unavailable, callers fall back to the
// ABOUTME: existing headless child-process path — precision never depends on
// ABOUTME: Herdr being present.
// ABOUTME: Design notes (verified against herdr 0.8.2, protocol 20):
// ABOUTME:  - pane read is a SCREEN capture (ANSI + wrapped lines), so it is
// ABOUTME:    never used to parse JSON events. Completion is signalled by a
// ABOUTME:    marker FILE written by the launch script; the authoritative
// ABOUTME:    result text comes from pi's session JSONL file on disk.
// ABOUTME:  - pane run / send-text can drop the first character when the pane
// ABOUTME:    shell is not ready, and zsh's compinit security prompt can eat
// ABOUTME:    input. Mitigations: --env ZSH_DISABLE_COMPFIX=true on tab
// ABOUTME:    create, a leading Enter before the command, and a verify/retry
// ABOUTME:    loop driven by the marker file.
// ABOUTME:  - herdr auto-updates; protocol/version are checked per call.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── detection ─────────────────────────────────────

export interface HerdrInfo {
	available: boolean;
	version?: string;
	protocol?: number;
	serverRunning: boolean;
	reason?: string;
}

/** Check binary + environment + server in one cheap call. */
export function detectHerdr(forceEnvCheck = true): HerdrInfo {
	try {
		if (forceEnvCheck && process.env.HERDR_ENV !== "1") {
			return { available: false, serverRunning: false, reason: "not inside herdr (HERDR_ENV!=1)" };
		}
		// Respect the active named session (default-session check would miss it).
		const session = process.env.HERDR_SESSION || "";
		const cmd = ["herdr", ...(session ? ["--session", session] : []), "status", "--json"];
		const out = execFileSync(cmd[0], cmd.slice(1), { encoding: "utf8", timeout: 10_000 });
		const d = JSON.parse(out);
		const server = d.server || {};
		const client = d.client || {};
		const running = !!server.running;
		return {
			available: running,
			version: client.version,
			protocol: client.protocol,
			serverRunning: running,
			reason: running ? undefined : "herdr server not running",
		};
	} catch (err: any) {
		return { available: false, serverRunning: false, reason: err?.message || "herdr unavailable" };
	}
}

/** True when sub-agent dispatch should use the herdr transport. */
export function herdrEnabled(): boolean {
	if (process.env.PI_HERDR_SUBAGENTS === "0") return false;
	return detectHerdr(true).available;
}

// ── CLI helpers ───────────────────────────────────

export interface HerdrCliResult {
	stdout: string;
	stderr: string;
	code: number;
}

/** Run `herdr --session <session> <args...>` (session from env when present). */
export function herdrCli(args: string[], opts: { timeoutMs?: number; session?: string } = {}): HerdrCliResult {
	const session = opts.session || process.env.HERDR_SESSION || "";
	const cmd = ["herdr", ...(session ? ["--session", session] : []), ...args];
	try {
		const out = execFileSync(cmd[0], cmd.slice(1), {
			encoding: "utf8",
			timeout: opts.timeoutMs ?? 30_000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { stdout: out, stderr: "", code: 0 };
	} catch (err: any) {
		return {
			stdout: err?.stdout?.toString?.() || "",
			stderr: err?.stderr?.toString?.() || err?.message || "",
			code: err?.status ?? 1,
		};
	}
}

export interface HerdrTabRef {
	session: string;
	workspaceId: string;
	tabId: string;
	paneId: string;
}

/** Find a workspace by exact label; create when missing. Returns workspace id. */
export function ensureHerdrWorkspace(label: string, cwd: string): string | null {
	const list = herdrCli(["workspace", "list"]);
	if (list.code !== 0) return null;
	try {
		const ws = (JSON.parse(list.stdout).result?.workspaces || []) as Array<{ workspace_id: string; label: string }>;
		const match = ws.filter((w) => w.label === label);
		if (match.length === 1) return match[0].workspace_id;
	} catch {}
	const created = herdrCli(["workspace", "create", "--label", label, "--cwd", cwd]);
	if (created.code !== 0) return null;
	try {
		return JSON.parse(created.stdout).result?.workspace?.workspace_id ?? null;
	} catch {
		return null;
	}
}

/** Create a task tab. Uses --env ZSH_DISABLE_COMPFIX=true to avoid the zsh
 *  compinit security prompt eating input. Returns null on failure. */
export function createHerdrTaskTab(workspaceId: string, cwd: string, label: string): HerdrTabRef | null {
	const r = herdrCli(["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", label, "--no-focus", "--env", "ZSH_DISABLE_COMPFIX=true"], { timeoutMs: 30_000 });
	if (r.code !== 0) return null;
	try {
		const res = JSON.parse(r.stdout).result;
		const tabId = res?.tab?.tab_id;
		const paneId = res?.root_pane?.pane_id;
		if (!tabId || !paneId) return null;
		return { session: process.env.HERDR_SESSION || "", workspaceId, tabId, paneId };
	} catch {
		return null;
	}
}

/**
 * Send a command to the pane robustly:
 * 1. leading Enter (clears any pending prompt state)
 * 2. send-text (literal, no re-parsing)
 * 3. Enter to submit
 * Returns true when the send calls succeeded (not when the command ran).
 */
export function sendCommandToPane(paneId: string, command: string): boolean {
	const enter = herdrCli(["pane", "send-keys", paneId, "Enter"], { timeoutMs: 15_000 });
	const text = herdrCli(["pane", "send-text", paneId, command], { timeoutMs: 15_000 });
	const submit = herdrCli(["pane", "send-keys", paneId, "Enter"], { timeoutMs: 15_000 });
	return enter.code === 0 && text.code === 0 && submit.code === 0;
}

/** Close a tab (best-effort; also used for cancel). */
export function closeHerdrTab(tab: HerdrTabRef): void {
	herdrCli(["tab", "close", tab.tabId], { timeoutMs: 15_000 });
}

/** One shell-quoted token. */
export function shellQuote(s: string): string {
	// single-quote each token; a literal ' becomes the standard bash "'\''" dance
	return "'" + s.split("'").join("'\\''") + "'";
}

export interface LaunchScriptOpts {
	dir: string;
	id: string;
	cwd: string;
	/** argv for the command (e.g. ["pi", "--mode", "json", ...]). */
	command: string[];
	/** Extra env vars for the command, e.g. PI_SUBAGENT=1. */
	env?: Record<string, string>;
}

export interface LaunchScriptRefs {
	scriptPath: string;
	donePath: string;
}

/** Write a bash script that runs the command and writes the exit code to a
 *  marker file. Returns paths. The script itself handles cwd and env. */
export function writeLaunchScript(opts: LaunchScriptOpts): LaunchScriptRefs {
	mkdirSync(opts.dir, { recursive: true });
	const scriptPath = join(opts.dir, `herdr-launch-${opts.id}.sh`);
	const donePath = join(opts.dir, `herdr-launch-${opts.id}.done`);
	const envAssign = Object.entries(opts.env || {})
		.map(([k, v]) => `export ${k}=${shellQuote(v)}`)
		.join("\n");
	const quoted = opts.command.map(shellQuote).join(" ");
	const script = `#!/bin/bash\n${envAssign}\ncd ${shellQuote(opts.cwd)} || exit 9\n${quoted}\nrc=$?\necho "$rc" > ${shellQuote(donePath)}\nexit $rc\n`;
	writeFileSync(scriptPath, script, "utf8");
	return { scriptPath, donePath };
}

/** Blocking 1s tick without spawning a process. */
function tickSleep(): void {
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
	} catch {
		// fallback for environments without SharedArrayBuffer
	}
}

/** Poll the marker file until it exists. Returns the exit code, or null on
 *  timeout / abort. `aborted()` is consulted on each tick for cancellation. */
export function pollDoneFile(donePath: string, timeoutMs: number, aborted?: () => boolean): number | null {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (aborted?.()) return null;
		try {
			if (existsSync(donePath)) {
				return parseInt(readFileSync(donePath, "utf8").trim(), 10) || 0;
			}
		} catch {}
		tickSleep();
	}
	return null;
}

/**
 * Async marker-file poll (non-blocking, keeps the pi TUI event loop alive).
 * Resolves with the exit code, or null on timeout / abort.
 */
export async function pollDoneFileAsync(
	donePath: string,
	timeoutMs: number,
	aborted?: () => boolean,
): Promise<number | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (aborted?.()) return null;
		try {
			if (existsSync(donePath)) {
				return parseInt(readFileSync(donePath, "utf8").trim(), 10) || 0;
			}
		} catch {}
		await new Promise<void>((res) => setTimeout(res, 1000));
	}
	return null;
}

export function cleanupLaunchFiles(refs: LaunchScriptRefs): void {
	try { rmSync(refs.scriptPath, { force: true }); } catch {}
	try { rmSync(refs.donePath, { force: true }); } catch {}
}

// ── result extraction from pi session JSONL ───────

export interface SessionTextResult {
	text: string;
	found: boolean;
}

/** Extract the LAST assistant text message from a pi session JSONL file.
 *  This is the authoritative transcript source (no terminal capture). */
export function readLastAssistantText(sessionFile: string): SessionTextResult {
	if (!existsSync(sessionFile)) return { text: "", found: false };
	let last: string | undefined;
	try {
		for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const e = JSON.parse(line);
				const msg = e?.message || e;
				if (msg?.role === "assistant" && Array.isArray(msg?.content)) {
					for (const part of msg.content) {
						if (part?.type === "text" && typeof part.text === "string" && part.text.length > 0) {
							last = part.text;
						}
					}
				}
			} catch {}
		}
	} catch {}
	return { text: last || "", found: last !== undefined };
}
