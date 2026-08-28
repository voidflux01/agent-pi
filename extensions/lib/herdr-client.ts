// ABOUTME: Herdr transport for sub-agent dispatch (all pi child runtimes).
// ABOUTME: When the parent runs inside Herdr (HERDR_ENV=1) and a server is
// ABOUTME: reachable, sub-agents run in a sibling split of the caller's pane
// ABOUTME: (watchable on the same screen). Fallback is a background tab when
// ABOUTME: split is unavailable. Pi children use the real interactive TUI
// ABOUTME: (visiblePiTuiArgs() drops `--mode json`/`-p` so the pane is never
// ABOUTME: a JSON stream); external runtimes tee output for parsing.
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
// ABOUTME:    input. Mitigations: --env ZSH_DISABLE_COMPFIX=true on pane split
// ABOUTME:    / tab create, a leading Enter before the command, and a
// ABOUTME:    verify/retry loop driven by the marker file.
// ABOUTME:  - closing a split must `pane close` the child only — never the
// ABOUTME:    parent's tab. Tab-created workers still close their own tab.
// ABOUTME:  - herdr auto-updates; protocol/version are checked per call.

import { execFile, execFileSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { childEnvironment } from "./child-runtime.ts";
import { isExplicitDispatchActive, explicitDispatchHandler } from "./dispatch-gate.ts";

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
		const out = execFileSync(cmd[0], cmd.slice(1), { encoding: "utf8", timeout: 10_000, env: childEnvironment() });
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
			env: childEnvironment(),
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

/** Non-blocking counterpart to herdrCli for UI/event-loop code paths. */
export function herdrCliAsync(args: string[], opts: { timeoutMs?: number; session?: string } = {}): Promise<HerdrCliResult> {
	const session = opts.session || process.env.HERDR_SESSION || "";
	const cmdArgs = [...(session ? ["--session", session] : []), ...args];
	return new Promise((resolve) => {
		execFile("herdr", cmdArgs, {
			encoding: "utf8",
			timeout: opts.timeoutMs ?? 30_000,
			env: childEnvironment(),
		}, (error, stdout, stderr) => {
			resolve({
				stdout: stdout?.toString?.() || "",
				stderr: stderr?.toString?.() || error?.message || "",
				code: error ? ((error as any).status ?? 1) : 0,
			});
		});
	});
}

/** Async Herdr availability check; unlike detectHerdr it never blocks the TUI. */
let herdrCheckInFlight: Promise<boolean> | undefined;
export function herdrEnabledAsync(): Promise<boolean> {
	if (process.env.PI_HERDR_SUBAGENTS === "0" || process.env.HERDR_ENV !== "1") return Promise.resolve(false);
	if (herdrCheckInFlight) return herdrCheckInFlight;
	herdrCheckInFlight = herdrCliAsync(["status", "--json"], { timeoutMs: 3_000 }).then((r) => {
		if (r.code !== 0) return false;
		try { return !!JSON.parse(r.stdout)?.server?.running; } catch { return false; }
	}).finally(() => { herdrCheckInFlight = undefined; });
	return herdrCheckInFlight;
}

export type HerdrCloseTarget = "tab" | "pane";

export interface HerdrTabRef {
	session: string;
	workspaceId: string;
	tabId: string;
	paneId: string;
	/** `pane` = sibling split (close only that pane). `tab` = we created the tab. */
	closeTarget?: HerdrCloseTarget;
}

export interface HerdrSnapshotAgent {
	agent?: string;
	agent_status?: string;
	pane_id?: string;
	tab_id?: string;
	workspace_id?: string;
	cwd?: string;
}

export interface HerdrSnapshot {
	agents: HerdrSnapshotAgent[];
	focused_pane_id?: string;
	focused_tab_id?: string;
}

/** Read the server snapshot without blocking the Pi event loop. */
export async function herdrSnapshotAsync(): Promise<HerdrSnapshot | null> {
	if (process.env.HERDR_ENV !== "1") return null;
	const result = await herdrCliAsync(["api", "snapshot"], { timeoutMs: 3_000 });
	if (result.code !== 0) return null;
	try {
		const snapshot = JSON.parse(result.stdout)?.result?.snapshot;
		return snapshot && Array.isArray(snapshot.agents)
			? snapshot as HerdrSnapshot
			: null;
	} catch {
		return null;
	}
}

export type HerdrPaneRecordStatus = "running" | "done" | "error";

/**
 * Durable metadata for a pane launched by agent-pi. The registry is not an
 * authority for results; it only lets a later parent inspect or reconnect a
 * visible worker. The session JSONL remains the source of truth.
 */
export interface HerdrPaneRecord {
	key: string;
	label: string;
	cwd: string;
	sessionFile?: string;
	ref: HerdrTabRef;
	scriptPath: string;
	donePath: string;
	startedPath: string;
	status: HerdrPaneRecordStatus;
	updatedAt: number;
}

function herdrPaneRegistryPath(cwd: string): string {
	return join(cwd, ".pi", "agent-sessions", "herdr-panes.json");
}

function readHerdrPaneRegistry(cwd: string): HerdrPaneRecord[] {
	try {
		const value = JSON.parse(readFileSync(herdrPaneRegistryPath(cwd), "utf8"));
		if (!Array.isArray(value)) return [];
		return value.filter((r): r is HerdrPaneRecord =>
			r && typeof r.key === "string" && typeof r.label === "string" &&
			r.ref && typeof r.ref.paneId === "string" && typeof r.ref.tabId === "string" &&
			typeof r.scriptPath === "string" && typeof r.donePath === "string" &&
			typeof r.startedPath === "string");
	} catch {
		return [];
	}
}

function writeHerdrPaneRegistry(cwd: string, records: HerdrPaneRecord[]): void {
	try {
		const file = herdrPaneRegistryPath(cwd);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(records, null, "\t") + "\n", "utf8");
	} catch {}
}

export function registerHerdrPane(cwd: string, record: Omit<HerdrPaneRecord, "updatedAt">): void {
	const records = readHerdrPaneRegistry(cwd).filter((r) => r.key !== record.key);
	records.push({ ...record, updatedAt: Date.now() });
	writeHerdrPaneRegistry(cwd, records);
}

export function updateHerdrPaneStatus(cwd: string, key: string, status: HerdrPaneRecordStatus, ref?: HerdrTabRef): void {
	const records = readHerdrPaneRegistry(cwd);
	let found = false;
	for (const record of records) {
		if (record.key !== key) continue;
		found = true;
		record.status = status;
		record.updatedAt = Date.now();
		if (ref) record.ref = ref;
	}
	if (found) writeHerdrPaneRegistry(cwd, records);
}

export function herdrPaneRecords(cwd: string): HerdrPaneRecord[] {
	return readHerdrPaneRegistry(cwd);
}

function snapshotHasPane(snapshot: HerdrSnapshot | null, ref: HerdrTabRef): boolean {
	return !!snapshot?.agents.some((agent) =>
		agent.pane_id === ref.paneId && agent.tab_id === ref.tabId &&
		(!agent.workspace_id || agent.workspace_id === ref.workspaceId));
}

export interface HerdrPaneInspection extends HerdrPaneRecord {
	health: "alive" | "missing" | "finished" | "unknown";
}

/** Inspect all persisted agent-pi panes with one Herdr snapshot request. */
export async function inspectHerdrPanesAsync(cwd: string): Promise<HerdrPaneInspection[]> {
	const records = readHerdrPaneRegistry(cwd);
	const snapshot = await herdrSnapshotAsync();
	return records.map((record) => ({
		...record,
		health: record.status !== "running"
			? "finished"
			: existsSync(record.donePath)
				? "finished"
				: snapshot === null ? "unknown"
					: snapshotHasPane(snapshot, record.ref) ? "alive" : "missing",
	}));
}

/** Recreate a missing pane and re-send its durable launch script. */
export async function reconnectHerdrPaneAsync(record: HerdrPaneRecord): Promise<{ ok: boolean; ref?: HerdrTabRef; reason: string }> {
	if (existsSync(record.donePath)) return { ok: false, reason: "launch already finished" };
	if (!existsSync(record.scriptPath)) return { ok: false, reason: "launch script is missing" };
	const snapshot = await herdrSnapshotAsync();
	if (!snapshot) return { ok: false, reason: "Herdr server is unavailable" };
	if (snapshotHasPane(snapshot, record.ref)) return { ok: true, ref: record.ref, reason: "pane is already alive" };
	const tab = await createHerdrTaskTabAsync(record.ref.workspaceId, record.cwd, record.label);
	if (!tab) return { ok: false, reason: "could not create replacement pane" };
	// A crashed parent may have left the old startup marker behind. Clear it
	// before sending so the handshake proves this replacement actually ran.
	rmSync(record.startedPath, { force: true });
	const sent = await sendCommandToPaneAsync(tab.paneId, `bash ${shellQuote(record.scriptPath)}`);
	if (!sent || !(await waitForLaunchStart(record.startedPath, 5_000))) {
		await closeHerdrTabAsync(tab);
		return { ok: false, reason: "replacement pane did not acknowledge launch" };
	}
	updateHerdrPaneStatus(record.cwd, record.key, "running", tab);
	return { ok: true, ref: tab, reason: "replacement pane launched" };
}


/** Register shared Herdr diagnostics for any extension that dispatches panes. */
export function registerHerdrCommands(pi: any): void {
	const g = globalThis as any;
	if (g.__piHerdrCommandsRegistered) return;
	g.__piHerdrCommandsRegistered = true;
	pi.registerCommand("herdr-status", {
		description: "Show health of agent-pi Herdr panes",
		handler: async (_args: string, ctx: any) => {
			const cwd = ctx?.cwd ?? process.cwd();
			const records = await inspectHerdrPanesAsync(cwd);
			const snapshot = await herdrSnapshotAsync();
			const lines = [`Herdr: ${snapshot ? "server reachable" : "server unavailable"}`];
			if (records.length === 0) lines.push("Managed panes: none");
			for (const pane of records) {
				lines.push(`  ${pane.key} ${pane.health} — tab ${pane.ref.tabId}, pane ${pane.ref.paneId}`);
			}
			lines.push("Registry: " + herdrPaneRegistryPath(cwd));
			ctx?.ui?.notify?.(lines.join("\n"), snapshot ? "info" : "warning");
		},
	});
	pi.registerCommand("herdr-reconnect", {
		description: "Reconnect missing agent-pi Herdr panes",
		handler: explicitDispatchHandler("subagent-command", async (args: string, ctx: any) => {
			const cwd = ctx?.cwd ?? process.cwd();
			const target = args.trim().toLowerCase();
			const records = (await inspectHerdrPanesAsync(cwd)).filter((r) =>
				(!target || r.key.toLowerCase() === target || r.label.toLowerCase() === target) &&
				r.health === "missing" && r.status === "running");
			if (records.length === 0) {
				ctx?.ui?.notify?.(target ? `No missing running Herdr pane matched: ${target}` : "No missing running Herdr panes", "info");
				return;
			}
			const results: string[] = [];
			for (const record of records) {
				const result = await reconnectHerdrPaneAsync(record);
				results.push(`${record.key}: ${result.ok ? "reconnected" : "failed — " + result.reason}`);
			}
			ctx?.ui?.notify?.(results.join("\n"), results.every((line) => line.includes("reconnected")) ? "success" : "warning");
		}),
	});
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

/** Herdr pane label that includes the role, e.g. `scout-sa1`. */
export function herdrWorkerLabel(role: string, id: string): string {
	const r = String(role || "agent").trim().replace(/\s+/g, "-").slice(0, 24) || "agent";
	const i = String(id || "").trim().replace(/\s+/g, "-").slice(0, 40);
	return i ? `${r}-${i}` : r;
}

/**
 * Wide panes split to the right so parent and child sit side by side;
 * tall or already-narrow panes split down to avoid unusable columns.
 */
export function splitDirectionFromRect(rect: { width: number; height: number }): "right" | "down" {
	const width = Number(rect.width);
	const height = Number(rect.height);
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "right";
	return width >= height * 1.25 ? "right" : "down";
}

export function parseCallerPaneRect(layoutStdout: string, paneId: string): { width: number; height: number } | null {
	try {
		const panes = JSON.parse(layoutStdout)?.result?.layout?.panes;
		if (!Array.isArray(panes)) return null;
		const mine = panes.find((p: { pane_id?: string }) => p?.pane_id === paneId);
		const rect = mine?.rect;
		if (!rect || typeof rect.width !== "number" || typeof rect.height !== "number") return null;
		return { width: rect.width, height: rect.height };
	} catch {
		return null;
	}
}

export function parseSplitPaneRef(splitStdout: string, fallback: { tabId?: string; workspaceId?: string } = {}): HerdrTabRef | null {
	try {
		const pane = JSON.parse(splitStdout)?.result?.pane;
		const paneId = pane?.pane_id;
		const tabId = pane?.tab_id || fallback.tabId;
		const workspaceId = pane?.workspace_id || fallback.workspaceId;
		if (!paneId || !tabId || !workspaceId) return null;
		return {
			session: process.env.HERDR_SESSION || "",
			workspaceId,
			tabId,
			paneId,
			closeTarget: "pane",
		};
	} catch {
		return null;
	}
}

/** CLI args that dispose a worker without touching the caller's own tab. */
export function herdrCloseArgs(tab: HerdrTabRef): string[] {
	const callerPane = process.env.HERDR_PANE_ID;
	const callerTab = process.env.HERDR_TAB_ID;
	if (callerPane && tab.paneId === callerPane) return [];
	const target = tab.closeTarget ?? "tab";
	if (target === "pane") return ["pane", "close", tab.paneId];
	if (callerTab && tab.tabId === callerTab) return ["pane", "close", tab.paneId];
	return ["tab", "close", tab.tabId];
}

function preferCallerPaneSplit(): boolean {
	return process.env.PI_HERDR_SPLIT !== "0" && !!process.env.HERDR_PANE_ID;
}

function tabRefFromCreate(stdout: string, workspaceId: string): HerdrTabRef | null {
	try {
		const res = JSON.parse(stdout).result;
		const tabId = res?.tab?.tab_id;
		const paneId = res?.root_pane?.pane_id;
		if (!tabId || !paneId) return null;
		return {
			session: process.env.HERDR_SESSION || "",
			workspaceId,
			tabId,
			paneId,
			closeTarget: "tab",
		};
	} catch {
		return null;
	}
}

function splitCallerPane(cwd: string, label: string): HerdrTabRef | null {
	const paneId = process.env.HERDR_PANE_ID;
	if (!paneId) return null;
	const layout = herdrCli(["pane", "layout", "--pane", paneId], { timeoutMs: 5_000 });
	const rect = layout.code === 0 ? parseCallerPaneRect(layout.stdout, paneId) : null;
	const direction = rect ? splitDirectionFromRect(rect) : "right";
	const split = herdrCli([
		"pane", "split", "--pane", paneId, "--direction", direction,
		"--cwd", cwd, "--no-focus", "--env", "ZSH_DISABLE_COMPFIX=true",
	], { timeoutMs: 30_000 });
	if (split.code !== 0) return null;
	const ref = parseSplitPaneRef(split.stdout, {
		tabId: process.env.HERDR_TAB_ID,
		workspaceId: process.env.HERDR_WORKSPACE_ID,
	});
	if (!ref || ref.paneId === paneId) {
		const orphan = parseSplitPaneRef(split.stdout)?.paneId;
		if (orphan && orphan !== paneId) herdrCli(["pane", "close", orphan], { timeoutMs: 5_000 });
		return null;
	}
	if (label) herdrCli(["pane", "rename", ref.paneId, label], { timeoutMs: 5_000 });
	return ref;
}

async function splitCallerPaneAsync(cwd: string, label: string): Promise<HerdrTabRef | null> {
	const paneId = process.env.HERDR_PANE_ID;
	if (!paneId) return null;
	const layout = await herdrCliAsync(["pane", "layout", "--pane", paneId], { timeoutMs: 5_000 });
	const rect = layout.code === 0 ? parseCallerPaneRect(layout.stdout, paneId) : null;
	const direction = rect ? splitDirectionFromRect(rect) : "right";
	const split = await herdrCliAsync([
		"pane", "split", "--pane", paneId, "--direction", direction,
		"--cwd", cwd, "--no-focus", "--env", "ZSH_DISABLE_COMPFIX=true",
	], { timeoutMs: 30_000 });
	if (split.code !== 0) return null;
	const ref = parseSplitPaneRef(split.stdout, {
		tabId: process.env.HERDR_TAB_ID,
		workspaceId: process.env.HERDR_WORKSPACE_ID,
	});
	if (!ref || ref.paneId === paneId) {
		const orphan = parseSplitPaneRef(split.stdout)?.paneId;
		if (orphan && orphan !== paneId) await herdrCliAsync(["pane", "close", orphan], { timeoutMs: 5_000 });
		return null;
	}
	if (label) await herdrCliAsync(["pane", "rename", ref.paneId, label], { timeoutMs: 5_000 });
	return ref;
}

/** Open a watchable worker: sibling split of the caller pane when possible,
 *  otherwise a background tab. Uses --env ZSH_DISABLE_COMPFIX=true to avoid
 *  the zsh compinit security prompt eating input. Returns null on failure. */
export function createHerdrTaskTab(workspaceId: string, cwd: string, label: string): HerdrTabRef | null {
	if (!isExplicitDispatchActive()) return null;
	if (preferCallerPaneSplit()) {
		const split = splitCallerPane(cwd, label);
		if (split) return split;
	}
	const r = herdrCli(["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", label, "--no-focus", "--env", "ZSH_DISABLE_COMPFIX=true"], { timeoutMs: 30_000 });
	if (r.code !== 0) return null;
	return tabRefFromCreate(r.stdout, workspaceId);
}

/** Async workspace lookup/create for non-blocking dispatch paths.
 * A per-directory lock prevents concurrent agents from creating duplicate
 * workspaces before the first ledger write becomes visible. */
const workspaceCreationInFlight = new Map<string, Promise<string | null>>();
export function ensureHerdrWorkspaceAsync(label: string, cwd: string): Promise<string | null> {
	const key = `${cwd}\0${label}`;
	const existing = workspaceCreationInFlight.get(key);
	if (existing) return existing;
	const operation = (async () => {
		const ledger = readWorkspaceLedger(cwd);
		const remembered = ledger[label];
		if (remembered) {
			const list = await herdrCliAsync(["workspace", "list"]);
			if (list.code === 0) {
				try {
					const ws = (JSON.parse(list.stdout).result?.workspaces || []) as Array<{ workspace_id: string }>;
					if (ws.some((w) => w.workspace_id === remembered)) return remembered;
				} catch {}
			}
		}
		const created = await herdrCliAsync(["workspace", "create", "--label", label, "--cwd", cwd]);
		if (created.code !== 0) return null;
		try {
			const id = JSON.parse(created.stdout).result?.workspace?.workspace_id ?? null;
			if (id) writeWorkspaceLedger(cwd, { ...ledger, [label]: id });
			return id;
		} catch { return null; }
	})();
	workspaceCreationInFlight.set(key, operation);
	void operation.then(
		() => workspaceCreationInFlight.delete(key),
		() => workspaceCreationInFlight.delete(key),
	);
	return operation;
}

/** Async watchable-worker creation: sibling split, else background tab. */
export async function createHerdrTaskTabAsync(workspaceId: string, cwd: string, label: string): Promise<HerdrTabRef | null> {
	if (!isExplicitDispatchActive()) return null;
	if (preferCallerPaneSplit()) {
		const split = await splitCallerPaneAsync(cwd, label);
		if (split) return split;
	}
	const r = await herdrCliAsync(["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", label, "--no-focus", "--env", "ZSH_DISABLE_COMPFIX=true"], { timeoutMs: 30_000 });
	if (r.code !== 0) return null;
	return tabRefFromCreate(r.stdout, workspaceId);
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

/** Close a worker we created (best-effort; also used for cancel).
 *  Split workers close only their pane; tab workers close their tab.
 *  Never closes the caller's own pane or tab. */
export function closeHerdrTab(tab: HerdrTabRef): void {
	const args = herdrCloseArgs(tab);
	if (args.length === 0) return;
	herdrCli(args, { timeoutMs: 15_000 });
}

/** Non-blocking version of sendCommandToPane; preserves command ordering. */
export async function sendCommandToPaneAsync(paneId: string, command: string): Promise<boolean> {
	const enter = await herdrCliAsync(["pane", "send-keys", paneId, "Enter"], { timeoutMs: 15_000 });
	const text = await herdrCliAsync(["pane", "send-text", paneId, command], { timeoutMs: 15_000 });
	const submit = await herdrCliAsync(["pane", "send-keys", paneId, "Enter"], { timeoutMs: 15_000 });
	return enter.code === 0 && text.code === 0 && submit.code === 0;
}

/** Non-blocking best-effort worker close (pane or tab, never the caller). */
export async function closeHerdrTabAsync(tab: HerdrTabRef): Promise<void> {
	const args = herdrCloseArgs(tab);
	if (args.length === 0) return;
	await herdrCliAsync(args, { timeoutMs: 15_000 });
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
 * Expects argv *after* the executable. Returns the argv unchanged when there
 * is nothing headless to strip.
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

/** Split a full command (`["pi", ...flags, task]`) into executable + argv. */
export function splitPiCommand(command: string[]): { executable: string; args: string[] } {
	const first = command[0];
	if (first && !first.startsWith("-")) {
		return { executable: first, args: command.slice(1) };
	}
	return { executable: "pi", args: command };
}

/**
 * Watchable Herdr launch argv, including the executable once.
 *
 * Callers pass the same `command` used for headless spawn (`["pi", ...args]`).
 * Passing that array through `visiblePiTuiArgs` and then prepending `pi` again
 * produces `pi pi ...`, and the extra `pi` becomes the child's first user
 * message.
 */
export function visiblePiTuiCommand(command: string[], herdrDoneExtPath: string): string[] {
	const { executable, args } = splitPiCommand(command);
	return [executable, ...visiblePiTuiArgs(args, herdrDoneExtPath)];
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
	startedPath: string;
}

/** Marker-file path for a launch id. Same naming writeLaunchScript() uses, so
 *  callers can point HERDR_DONE_PATH at it before the refs exist. */
const SAFE_LAUNCH_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function launchDonePath(dir: string, id: string): string {
	if (!SAFE_LAUNCH_ID.test(id)) throw new Error("Invalid Herdr launch id");
	return join(dir, `herdr-launch-${id}.done`);
}

/** Marker written when the pane's shell has accepted and started the launch script. */
export function launchStartedPath(dir: string, id: string): string {
	if (!SAFE_LAUNCH_ID.test(id)) throw new Error("Invalid Herdr launch id");
	return join(dir, `herdr-launch-${id}.started`);
}

/** Write a bash script that runs the command and writes the exit code to a
 *  marker file. Returns paths. The script itself handles cwd and env. */
export function writeLaunchScript(opts: LaunchScriptOpts): LaunchScriptRefs {
	mkdirSync(opts.dir, { recursive: true });
	const scriptPath = join(opts.dir, `herdr-launch-${opts.id}.sh`);
	const donePath = launchDonePath(opts.dir, opts.id);
	const startedPath = launchStartedPath(opts.dir, opts.id);
	// A crashed parent can leave previous markers behind. Never let a new
	// launch inherit stale startup or completion signals.
	rmSync(donePath, { force: true });
	rmSync(startedPath, { force: true });
	const envAssign = Object.entries(opts.env || {})
		.filter(([k, v]) => v !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
		.map(([k, v]) => `export ${k}=${shellQuote(v as string)}`)
		.join("\n");
	const quoted = opts.command.map(shellQuote).join(" ");
	const script = `#!/bin/bash\n${envAssign}\ncd ${shellQuote(opts.cwd)} || exit 9\nprintf 'started\n' > ${shellQuote(startedPath)}\n${quoted}\nrc=$?\necho "$rc" > ${shellQuote(donePath)}\nexit $rc\n`;
	writeFileSync(scriptPath, script, "utf8");
	return { scriptPath, donePath, startedPath };
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
	try { rmSync(refs.startedPath, { force: true }); } catch {}
}

/** Wait briefly for the launch script to prove that the pane accepted it. */
export async function waitForLaunchStart(startedPath: string, timeoutMs = 5_000, aborted?: () => boolean): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (aborted?.()) return false;
		try {
			if (existsSync(startedPath) && readFileSync(startedPath, "utf8").trim() === "started") return true;
		} catch {}
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
	}
	return false;
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

const SESSION_TAIL_BYTES = 256 * 1024;

/**
 * Read only the newest complete JSONL lines. This function runs from live
 * dashboard timers, so scanning a growing transcript synchronously would
 * otherwise block the Pi TUI every few seconds. Result persistence and usage
 * accounting still deliberately scan the full file at completion time.
 */
function readSessionTail(sessionFile: string): string {
	const fd = openSync(sessionFile, "r");
	try {
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - SESSION_TAIL_BYTES);
		const buffer = Buffer.alloc(size - start);
		let offset = 0;
		while (offset < buffer.length) {
			const count = readSync(fd, buffer, offset, buffer.length - offset, start + offset);
			if (count === 0) break;
			offset += count;
		}
		let text = buffer.subarray(0, offset).toString("utf8");
		if (start > 0) {
			const firstNewline = text.indexOf("\n");
			if (firstNewline < 0) return "";
			text = text.slice(firstNewline + 1);
		}
		return text;
	} finally {
		closeSync(fd);
	}
}

export function readLastAssistantText(sessionFile: string): SessionTextResult {
	if (!existsSync(sessionFile)) return { text: "", found: false };
	let last: string | undefined;
	try {
		for (const line of readSessionTail(sessionFile).split("\n")) {
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
