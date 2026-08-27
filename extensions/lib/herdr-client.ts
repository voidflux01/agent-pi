// ABOUTME: Herdr transport for sub-agent dispatch (all pi child runtimes).
// ABOUTME: When the parent runs inside Herdr (HERDR_ENV=1) and a server is
// ABOUTME: reachable, sub-agents run inside a Herdr pane: pi children in
// ABOUTME: pi's real interactive TUI (visiblePiTuiArgs() drops the headless
// ABOUTME: `--mode json`/`-p` so the tab is watchable, never a JSON stream),
// ABOUTME: external runtimes as their own CLI with output tee'd for parsing.
// ABOUTME: Panes stay persistent across parent restarts and resumable via the
// ABOUTME: session file. When Herdr is unavailable, callers fall back to the
// ABOUTME: existing headless child-process path — precision never depends on
// ABOUTME: Herdr being present.
// ABOUTME: Design notes (verified against herdr 0.8.2, protocol 20):
// ABOUTME:  - pane read is a SCREEN capture (ANSI + wrapped lines), so it is
// ABOUTME:    never used to parse JSON events. Completion is signalled by a
// ABOUTME:    marker FILE ($HERDR_DONE_PATH, written on the child's first
// ABOUTME:    agent_end by herdr-done.ts, with the launch script's process-exit
// ABOUTME:    write as fallback); the authoritative result text comes from pi's
// ABOUTME:    session JSONL file on disk.
// ABOUTME:  - pane run / send-text can drop the first character when the pane
// ABOUTME:    shell is not ready, and zsh's compinit security prompt can eat
// ABOUTME:    input. Mitigations: --env ZSH_DISABLE_COMPFIX=true on tab
// ABOUTME:    create, a leading Enter before the command, and a verify/retry
// ABOUTME:    loop driven by the marker file.
// ABOUTME:  - herdr auto-updates; protocol/version are checked per call.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

/**
 * Provenance ledger for workspaces agent-pi created, stored next to the
 * task journal. Only ids recorded here are ever reused - a user's own
 * same-label workspace can never be hijacked for task tabs.
 */
function workspaceLedgerPath(cwd: string): string {
	return join(cwd, ".pi", "agent-sessions", "herdr-workspaces.json");
}

function readWorkspaceLedger(cwd: string): Record<string, string> {
	try {
		return JSON.parse(readFileSync(workspaceLedgerPath(cwd), "utf8")) as Record<string, string>;
	} catch {
		return {};
	}
}

function writeWorkspaceLedger(cwd: string, ledger: Record<string, string>): void {
	try {
		mkdirSync(dirname(workspaceLedgerPath(cwd)), { recursive: true });
		writeFileSync(workspaceLedgerPath(cwd), JSON.stringify(ledger, null, "\t") + "\n", "utf8");
	} catch {}
}

/**
 * Reuse a workspace agent-pi itself created earlier (recorded in the
 * local ledger and still listed by herdr); otherwise create one. A
 * user's own same-label workspace is never reused because only ledgered
 * ids count as ours. Best-effort stamping + recording: failures fall
 * back to plain create-and-return.
 */
export function ensureHerdrWorkspace(label: string, cwd: string): string | null {
	const ledger = readWorkspaceLedger(cwd);
	const remembered = ledger[label];
	if (remembered) {
		const list = herdrCli(["workspace", "list"]);
		if (list.code === 0) {
			try {
				const ws = (JSON.parse(list.stdout).result?.workspaces || []) as Array<{ workspace_id: string }>;
				if (ws.some((w) => w.workspace_id === remembered)) return remembered;
			} catch {}
		}
	}
	const created = herdrCli(["workspace", "create", "--label", label, "--cwd", cwd]);
	if (created.code !== 0) return null;
	try {
		const id = JSON.parse(created.stdout).result?.workspace?.workspace_id ?? null;
		if (id) {
			writeWorkspaceLedger(cwd, { ...ledger, [label]: id });
		}
		return id;
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

// ── watchable argv ───────────────────────────────────────────

/**
 * Convert a headless pi argv into one an operator can watch.
 *
 * The invisible spawn paths need machine-readable, exit-when-done output, so
 * they carry `--mode json` and `-p`. Inside a Herdr pane those two flags turn
 * the tab into a wall of raw JSON events, so the visible transport drops them
 * and lets pi run its real TUI with the same session, model, tools, system
 * prompt, extensions, and task text.
 *
 * It also appends `-e <herdrDoneExtPath>`: a TUI worker does not exit when its
 * task is done, so herdr-done.ts writes the completion marker on the first
 * agent_end. pi parses options in one order-independent pass, so the pair is
 * inserted right after the last existing `-e` to keep the explicit extension
 * group together.
 *
 * Returns the argv unchanged when there is nothing headless to strip.
 */
export function visiblePiTuiArgs(args: string[], herdrDoneExtPath: string): string[] {
	const stripped: string[] = [];
	let strippedAnything = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--mode" && (args[i + 1] === "json" || args[i + 1] === "rpc")) {
			i++;
			strippedAnything = true;
			continue;
		}
		if (a === "-p" || a === "--print") {
			strippedAnything = true;
			continue;
		}
		stripped.push(a);
	}
	if (!strippedAnything) return stripped;

	let insertAt = 0;
	for (let i = 0; i < stripped.length - 1; i++) {
		if (stripped[i] === "-e" || stripped[i] === "--extension") insertAt = i + 2;
	}
	return [...stripped.slice(0, insertAt), "-e", herdrDoneExtPath, ...stripped.slice(insertAt)];
}

export interface LaunchScriptOpts {
	dir: string;
	id: string;
	cwd: string;
	/** argv for the command (e.g. ["pi", "--mode", "json", ...]). */
	command: string[];
	/** Extra env vars for the command, e.g. PI_SUBAGENT=1.
	 *  Undefined values are skipped (never serialized). */
	env?: Record<string, string | undefined>;
}

export interface LaunchScriptRefs {
	scriptPath: string;
	donePath: string;
}

/** Marker-file path for a launch id. Same naming writeLaunchScript() uses, so
 *  callers can point HERDR_DONE_PATH at it before the refs exist. */
const SAFE_LAUNCH_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function launchDonePath(dir: string, id: string): string {
	if (!SAFE_LAUNCH_ID.test(id)) throw new Error("Invalid Herdr launch id");
	return join(dir, `herdr-launch-${id}.done`);
}

/** Write a bash script that runs the command and writes the exit code to a
 *  marker file. Returns paths. The script itself handles cwd and env. */
export function writeLaunchScript(opts: LaunchScriptOpts): LaunchScriptRefs {
	mkdirSync(opts.dir, { recursive: true });
	const scriptPath = join(opts.dir, `herdr-launch-${opts.id}.sh`);
	const donePath = launchDonePath(opts.dir, opts.id);
	// A crashed parent can leave the previous marker behind. Never let a new
	// launch inherit that stale completion signal.
	rmSync(donePath, { force: true });
	const envAssign = Object.entries(opts.env || {})
		.filter(([k, v]) => v !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
		.map(([k, v]) => `export ${k}=${shellQuote(v as string)}`)
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
				const code = Number.parseInt(readFileSync(donePath, "utf8").trim(), 10);
				if (Number.isFinite(code)) return code;
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
				const code = Number.parseInt(readFileSync(donePath, "utf8").trim(), 10);
				if (Number.isFinite(code)) return code;
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
export interface SessionUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	costUsd: number;
	assistantMessages: number;
}

/**
 * Sum token usage + cost across every assistant message in a pi session
 * JSONL. Missing/corrupt lines are skipped; files that exist but carry no
 * usage yield zeros - callers decide whether zeros are meaningful.
 */
export function sessionUsage(sessionFile: string): SessionUsage {
	const out: SessionUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0, assistantMessages: 0 };
	if (!existsSync(sessionFile)) return out;
	try {
		for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const e = JSON.parse(line);
				const msg = e?.message || e;
				if (msg?.role !== "assistant") continue;
				const u = msg?.usage;
				if (!u || typeof u !== "object") continue;
				out.input += Number(u.input) || 0;
				out.output += Number(u.output) || 0;
				out.cacheRead += Number(u.cacheRead) || 0;
				out.cacheWrite += Number(u.cacheWrite) || 0;
				const declared = Number(u.totalTokens);
				out.totalTokens += Number.isFinite(declared) && declared > 0 ? declared : (Number(u.input) || 0) + (Number(u.output) || 0);
				const c = u.cost;
				if (c && typeof c === "object") out.costUsd += Number(c.total) || 0;
				out.assistantMessages += 1;
			} catch {}
		}
	} catch {}
	return out;
}

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
