// ABOUTME: Shared toolkit CLI metadata, worker-model resolution, and worker spawning.
// ABOUTME: Toolkit agents represent installed CLI software and should stream real CLI stdout/stderr.

import { spawn } from "child_process";
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { childEnvironment } from "./child-runtime.ts";
import { isExplicitDispatchActive } from "./dispatch-gate.ts";
import { DEFAULT_POLL_TIMEOUT_MS } from "./dispatch-runtime.ts";
import { activeOrchestrationBudget, budgetBlockReason, defaultBudgetReservation, reserveBudget } from "./orchestration-budget.ts";
import { createOrchestrationRun, DEFAULT_ORCHESTRATION_TIMEOUT_MS } from "./orchestration-run.ts";
import { journalUpdate } from "./agent-task-journal.ts";
import {
	herdrEnabledAsync,
	ensureHerdrWorkspaceAsync,
	createHerdrTaskTabAsync,
	sendCommandToPaneAsync,
	closeHerdrTabAsync,
	writeLaunchScript,
	pollDoneFileAsync,
	waitForLaunchStart,
	cleanupLaunchFiles,
	registerHerdrPane,
	stampHerdrPaneIdentityAsync,
	launchDonePath,
	herdrPaneAutoCloseMs,
	scheduleHerdrPaneClose,
} from "./herdr-client.ts";

export const TOOLKIT_CLI_AGENTS = new Set([
	"cursor-agent",
	"codex-agent",
	"gemini-agent",
	"qwen-agent",
	"omp-agent",
	"groq-agent",
	"droid-agent",
	"crush-agent",
	"prime-agent",
]);

export const TOOLKIT_WORKER_MODEL = "anthropic/claude-haiku-4-5-20251001";

export interface ToolkitWorkerAgentDef {
	name: string;
	tools: string;
	systemPrompt: string;
}

export interface ToolkitWorkerSpawnOptions {
	task: string;
	sessionFile?: string;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	onStdoutLine?: (line: string) => void;
	onStderr?: (chunk: string) => void;
	/** Called for each attempt so the caller can cancel the live child. */
	onProcess?: (proc: any) => void;
	/** Polled while the worker runs (session switches and user aborts). */
	isCancelled?: () => boolean;
	/** Mode-owned deadline; 0 explicitly disables the watchdog. */
	timeoutMs?: number;
	/** Injected in tests; defaults to child_process.spawn. */
	spawnProcess?: typeof spawn;
}

interface ToolkitCliCommand {
	command: string;
	args: (task: string, cwd?: string) => string[];
	/** Fallback argv used once when the plain invocation fails early. */
	pureArgs?: (task: string, cwd?: string) => string[];
}

export interface ToolkitWorkerResult {
	exitCode: number;
	elapsed: number;
	output: string;
	failure?: "timeout" | "cancelled" | "process_error";
}

const TOOLKIT_ABORT_POLL_INTERVAL_MS = 50;
const TOOLKIT_FORCE_KILL_DELAY_MS = 3_000;
export const MAX_TOOLKIT_OUTPUT_CHARS = 256 * 1024;
const TOOLKIT_OUTPUT_TRUNCATION_MARKER = "\n...[toolkit output truncated]...\n";

export function appendBoundedOutput(current: string, chunk: string): string {
	const next = current + chunk;
	if (next.length <= MAX_TOOLKIT_OUTPUT_CHARS) return next;
	const budget = Math.max(0, MAX_TOOLKIT_OUTPUT_CHARS - TOOLKIT_OUTPUT_TRUNCATION_MARKER.length);
	const head = Math.ceil(budget / 2);
	return next.slice(0, head) + TOOLKIT_OUTPUT_TRUNCATION_MARKER + next.slice(-(budget - head));
}

export function isToolkitCliAgent(name: string | undefined | null): boolean {
	if (!name) return false;
	return TOOLKIT_CLI_AGENTS.has(name.toLowerCase());
}

export function resolveToolkitWorkerModel(agentName: string, fallbackModel: string): string {
	return isToolkitCliAgent(agentName) ? TOOLKIT_WORKER_MODEL : fallbackModel;
}

export function getToolkitWorkerArgs(agentDef: ToolkitWorkerAgentDef, options: ToolkitWorkerSpawnOptions): string[] {
	const args = [
		"--mode", "json",
		"-p",
		"--model", TOOLKIT_WORKER_MODEL,
		"--tools", agentDef.tools,
		"--append-system-prompt", agentDef.systemPrompt,
	];

	if (options.sessionFile) {
		args.push("--session", options.sessionFile);
	}

	args.push(options.task);
	return args;
}

/** Opt in to a bare CLI: no discovered extensions. Skills remain enabled so
 *  omp / prime keep their own tuned ~/.omp and ~/.prime configs. Isolation from
 *  the parent Pi home is always via env (PI_CODING_AGENT_DIR is not forwarded). */
export function toolkitBareMode(): boolean {
	return process.env.PI_TOOLKIT_BARE === "1";
}

function getToolkitCliCommand(agentName: string): ToolkitCliCommand | null {
	switch (agentName.toLowerCase()) {
		case "cursor-agent":
			return {
				command: "cursor-agent",
				args: (task: string) => ["--print", "--output-format", "text", task],
			};
		case "codex-agent":
			return {
				command: "codex",
				args: (task: string, cwd?: string) => ["exec", "--skip-git-repo-check", ...(cwd ? ["--cd", cwd] : []), task],
			};
		case "droid-agent":
			return {
				command: "droid",
				args: (task: string, cwd?: string) => ["exec", "--output-format", "text", "--auto", "low", ...(cwd ? ["--cwd", cwd] : []), task],
			};
		case "gemini-agent":
			return {
				command: "gemini",
				args: (task: string) => ["-p", task],
			};
		case "qwen-agent":
			return {
				command: "qwen",
				args: (task: string) => [task],
			};
		case "omp-agent":
			return {
				command: "omp",
				args: (task: string) => [
					"-p", "--mode", "json", "--no-session",
					...(toolkitBareMode() ? ["--no-extensions"] : []),
					task,
				],
			};
		case "prime-agent":
			return {
				command: "prime-agent",
				args: (task: string) => [
					"-p", "--mode", "json", "--no-session",
					...(toolkitBareMode() ? ["-ne"] : []),
					task,
				],
			};
		case "groq-agent":
			return {
				command: "groq",
				args: (task: string) => [task],
			};
		case "crush-agent":
			return {
				command: "crush",
				args: (task: string) => [task],
			};
		default:
			return null;
	}
}

export function toolkitHerdrDoneExtPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "herdr-done.ts");
}

/** omp / prime have a real TUI. Other toolkit CLIs are print-only. */
export function toolkitHasInteractiveTui(agentName: string | undefined | null): boolean {
	const n = (agentName || "").toLowerCase();
	return n === "omp-agent" || n === "prime-agent";
}

/** Interactive argv for a herdr pane (no `-p` / `--mode json`, so the TTY is a TUI). */
export function getToolkitTuiArgv(
	agentName: string,
	task: string,
	sessionDir: string,
	herdrDonePath: string,
): string[] | null {
	const bare = toolkitBareMode();
	switch (agentName.toLowerCase()) {
		case "omp-agent":
			return [
				"omp",
				"--session-dir", sessionDir,
				"-e", herdrDonePath,
				"--auto-approve",
				"--no-title",
				...(bare ? ["--no-extensions"] : []),
				task,
			];
		case "prime-agent":
			return [
				"prime-agent",
				"--session-dir", sessionDir,
				"-e", herdrDonePath,
				...(bare ? ["-ne"] : []),
				task,
			];
		default:
			return null;
	}
}

function newestJsonl(root: string): string | undefined {
	let best: { path: string; mtime: number } | undefined;
	const walk = (dir: string) => {
		let ents: Array<{ name: string; isDirectory(): boolean }>;
		try { ents = readdirSync(dir, { withFileTypes: true, encoding: "utf8" }); } catch { return; }
		for (const ent of ents) {
			const p = join(dir, ent.name);
			if (ent.isDirectory()) walk(p);
			else if (ent.name.endsWith(".jsonl")) {
				let mtime = 0;
				try { mtime = statSync(p).mtimeMs; } catch {}
				if (!best || mtime >= best.mtime) best = { path: p, mtime };
			}
		}
	};
	if (existsSync(root)) walk(root);
	return best?.path;
}

export function spawnToolkitWorker(
	agentDef: ToolkitWorkerAgentDef,
	options: ToolkitWorkerSpawnOptions,
): Promise<ToolkitWorkerResult> {
	if (!isExplicitDispatchActive()) {
		return Promise.resolve({
			exitCode: 126,
			elapsed: 0,
			output: "Toolkit worker refused: only an explicit tool or slash command may start a child",
		});
	}

	return new Promise((resolve) => {
		const cliCommand = getToolkitCliCommand(agentDef.name);
		const command = cliCommand?.command || "pi";
		const attempts: string[][] = [];
		const runAttempt = (): void => {
		let args = cliCommand
			? (attempts.length ? attempts[attempts.length - 1] : cliCommand.args(options.task, options.cwd))
			: (attempts.length ? attempts[attempts.length - 1] : getToolkitWorkerArgs(agentDef, options));
		if (options.isCancelled?.()) {
			resolve({ exitCode: 130, elapsed: 0, output: "Toolkit worker cancelled" });
			return;
		}
		let proc: ReturnType<typeof spawn>;
		try {
			proc = (options.spawnProcess || spawn)(resolveCommandPath(command), args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: childEnvironment({ ...options.env, PI_SUBAGENT: "1" }),
				cwd: options.cwd,
			});
		} catch (error) {
			const msg = `CLI spawn error (${command}): ${error instanceof Error ? error.message : String(error)}`;
			options.onStderr?.(msg);
			options.onStdoutLine?.(msg);
			resolve({ exitCode: 1, elapsed: 0, output: msg });
			return;
		}
		options.onProcess?.(proc);

		const startTime = Date.now();
		let output = "";
		let buffer = "";

		proc.stdout?.setEncoding("utf-8");
		proc.stdout?.on("data", (chunk: string) => {
			output = appendBoundedOutput(output, chunk);
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (line.trim()) options.onStdoutLine?.(line);
			}
		});

		proc.stderr?.setEncoding("utf-8");
		proc.stderr?.on("data", (chunk: string) => {
			output = appendBoundedOutput(output, chunk);
			if (chunk) options.onStderr?.(chunk);
			const lines = chunk.split("\n");
			for (const line of lines) {
				if (line.trim()) options.onStdoutLine?.(line);
			}
		});

		let cancelled = false;
		let timedOut = false;
		let failure: ToolkitWorkerResult["failure"];
		let settled = false;
		let abortTimer: ReturnType<typeof setInterval> | undefined;
		let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		const clearAttemptTimers = () => {
			if (abortTimer) clearInterval(abortTimer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			if (timeoutTimer) clearTimeout(timeoutTimer);
			abortTimer = undefined;
			forceKillTimer = undefined;
			timeoutTimer = undefined;
		};
		const finishWith = (exitCode: number, outText: string, preserveKillTimer = false) => {
			if (settled) return;
			settled = true;
			if (abortTimer) clearInterval(abortTimer);
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (!preserveKillTimer && forceKillTimer) clearTimeout(forceKillTimer);
			abortTimer = undefined;
			timeoutTimer = undefined;
			if (!preserveKillTimer) forceKillTimer = undefined;
			resolve({
				exitCode: timedOut ? 1 : cancelled ? 130 : exitCode,
				elapsed: Date.now() - startTime,
				output: cancelled ? (outText || "Toolkit worker cancelled") : outText,
				...(failure ? { failure } : {}),
			});
		};
		const cancel = () => {
			if (cancelled || settled) return;
			cancelled = true;
			if (!timedOut) failure = "cancelled";
			forceKillTimer = setTimeout(() => {
				try { proc.kill("SIGKILL"); } catch {}
			}, TOOLKIT_FORCE_KILL_DELAY_MS);
			try { proc.kill("SIGTERM"); } catch {}
		};
		const timeoutMs = options.timeoutMs ?? DEFAULT_ORCHESTRATION_TIMEOUT_MS;
		if (timeoutMs > 0) {
			timeoutTimer = setTimeout(() => {
				if (settled || cancelled) return;
				timedOut = true;
				failure = "timeout";
				const message = `Toolkit worker timed out after ${timeoutMs}ms`;
				output = appendBoundedOutput(output, message);
				options.onStderr?.(message);
				cancel();
				finishWith(1, output, true);
			}, timeoutMs);
		}
		if (options.isCancelled) {
			abortTimer = setInterval(() => {
				try {
					if (options.isCancelled?.()) cancel();
				} catch {
					cancel();
				}
			}, TOOLKIT_ABORT_POLL_INTERVAL_MS);
		}

		const retryWithPureArgsOr = (fallback: () => void) => {
			if (cliCommand?.pureArgs && attempts.length === 0) {
				settled = true;
				clearAttemptTimers();
				attempts.push(cliCommand.pureArgs(options.task, options.cwd));
				output = "";
				buffer = "";
				failure = undefined;
				runAttempt();
				return;
			}
			fallback();
		};

		proc.on("error", (err) => {
			if (cancelled) {
				finishWith(130, output);
				return;
			}
			const msg = `CLI spawn error (${command}): ${err.message}`;
			failure = "process_error";
			output = appendBoundedOutput(output, msg);
			options.onStderr?.(msg);
			options.onStdoutLine?.(msg);
			retryWithPureArgsOr(() => finishWith(1, msg));
		});

		proc.on("close", (code) => {
			if (forceKillTimer) clearTimeout(forceKillTimer);
			forceKillTimer = undefined;
			if (cancelled) {
				finishWith(130, output);
				return;
			}
			if (buffer.trim()) options.onStdoutLine?.(buffer);
			if ((code ?? 1) !== 0 && attempts.length === 0 && cliCommand?.pureArgs && /server error|UnknownError/i.test(output)) {
				retryWithPureArgsOr(() => finishWith(code ?? 1, output));
				return;
			}
			finishWith(code ?? 1, output);
		});
		};
		runAttempt();
	});
}

export interface ToolkitUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	costUsd: number;
}

/**
 * Parse a finished external-CLI run's raw stdout/stderr into an authoritative
 * result text plus optional token/cost usage. Knows the two JSON-streaming CLIs
 * (omp and prime-agent `-p --mode json`); everything else
 * falls back to the plain output tail. Never throws.
 */
export function parseToolkitResult(
	agentName: string | undefined,
	raw: string,
): { text: string; usage?: ToolkitUsage; model?: string } {
	const name = (agentName || "").toLowerCase();
	try {
		if (name === "prime-agent" || name === "omp-agent") {
			let text = "";
			let usage: ToolkitUsage | undefined;
			let model: string | undefined;
			for (const line of raw.split("\n")) {
				const t = line.trim();
				if (!t.startsWith("{")) continue;
				let ev: any;
				try { ev = JSON.parse(t); } catch { continue; }
				if (ev?.type === "error") {
					const errMsg = ev?.error?.data?.message || ev?.error?.message || JSON.stringify(ev.error ?? ev);
					text += `[${name} error] ${errMsg}`;
					continue;
				}
				if (ev?.type !== "message_end") continue;
				if (ev?.message?.role && ev.message.role !== "assistant") continue;
				const u = ev?.message?.usage;
				if (u && typeof u.totalTokens === "number") {
					usage = {
						input: u.input ?? 0,
						output: u.output ?? 0,
						cacheRead: u.cacheRead ?? 0,
						cacheWrite: u.cacheWrite ?? 0,
						totalTokens: u.totalTokens,
						costUsd: Number(u.cost?.total ?? 0),
					};
				}
				const provider = ev?.message?.provider;
				const modelId = ev?.message?.model;
				if (typeof modelId === "string" && modelId) {
					model = typeof provider === "string" && provider ? `${provider}/${modelId}` : modelId;
				}
				for (const c of ev?.message?.content ?? []) {
					if (c?.type === "text" && typeof c.text === "string") text += c.text;
				}
			}
			if (!text) {
				for (const line of raw.split("\n")) {
					const t = line.trim();
					if (!t.startsWith("{")) continue;
					let ev: any;
					try { ev = JSON.parse(t); } catch { continue; }
					const msg = ev?.message || ev;
					if (msg?.role !== "assistant" || !Array.isArray(msg?.content)) continue;
					const u = msg.usage;
					if (u && typeof u.totalTokens === "number") {
						usage = {
							input: u.input ?? 0,
							output: u.output ?? 0,
							cacheRead: u.cacheRead ?? 0,
							cacheWrite: u.cacheWrite ?? 0,
							totalTokens: u.totalTokens,
							costUsd: Number(u.cost?.total ?? 0),
						};
					}
					const provider = msg.provider;
					const modelId = msg.model;
					if (typeof modelId === "string" && modelId) {
						model = typeof provider === "string" && provider ? `${provider}/${modelId}` : modelId;
					}
					for (const c of msg.content) {
						if (c?.type === "text" && typeof c.text === "string" && c.text) text = c.text;
					}
				}
			}
			return { text, usage, model };
		}
	} catch {}
	// Plain-text CLIs and unparsable output: no structured extraction.
	return { text: "" };
}

/** Short runtime label for journal rows ("pi" rows leave it unset). */
/** Resolve a bare CLI name against PATH (node spawn on macOS GUI contexts
 *  may miss user-shell PATH entries). Returns input
 *  unchanged when it already contains a path separator or no candidate found. */
function resolveCommandPath(command: string): string {
	if (command.includes("/")) return command;
	for (const dir of (process.env.PATH || "").split(":")) {
		if (!dir) continue;
		const cand = join(dir, command);
		try {
			accessSync(cand, fsConstants.X_OK);
			return cand;
		} catch {}
	}
	return command;
}

function shellQuote(s: string): string {
	return /^[A-Za-z0-9_\-./:=@%^+]+$/.test(s) ? s : `'` + s.replace(/'/g, `'\\''`) + `'`;
}

export function toolkitRuntimeName(agentName: string | undefined | null): string | undefined {
	const n = (agentName || "").toLowerCase();
	if (!TOOLKIT_CLI_AGENTS.has(n)) return undefined;
	return n.endsWith("-agent") ? n.slice(0, -"-agent".length) : n;
}

/** Canonical herdr chrome name, e.g. `omp-agent` / `prime-agent`. */
export function toolkitHerdrAgent(agentName: string | undefined | null): string {
	const n = (agentName || "").toLowerCase().trim();
	return TOOLKIT_CLI_AGENTS.has(n) ? n : (n || "agent");
}

/** Tab/pane label: `omp-agent-sa1` when a run suffix is present, else `omp-agent`. */
export function toolkitHerdrLabel(agentName: string, paneTitle?: string): string {
	const agent = toolkitHerdrAgent(agentName);
	const title = String(paneTitle || "").trim().toLowerCase();
	if (title && (title === agent || title.startsWith(`${agent}-`))) return title;
	return agent;
}

/** Auto-close delay for a finished toolkit tab. Same policy as Pi workers:
 *  success 12s, error 30s, `PI_HERDR_LINGER_MS=keep` to leave it open. */
export function toolkitHerdrAutoCloseMs(kind: "success" | "error" = "success"): number | null {
	return herdrPaneAutoCloseMs(kind);
}

/**
 * Shell command line that runs an external CLI visibly inside a herdr pane.
 * omp / prime drop `-p --mode json` and `tee` so the pane is a real TUI;
 * other CLIs still print and tee to rawOutPath for parsing.
 */
export function toolkitVisibleCommandLine(
	agentName: string,
	task: string,
	cwd: string | undefined,
	rawOutPath: string,
	paneTitle?: string,
	tuiSessionDir?: string,
	herdrDonePath?: string,
): string[] {
	const title = (paneTitle || toolkitRuntimeName(agentName) || agentName)
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.slice(0, 40);
	const osc = `printf '\\033]0;${title}\\007'`;
	const sessionDir = tuiSessionDir || join(dirname(rawOutPath), "session");
	const doneExt = herdrDonePath || toolkitHerdrDoneExtPath();
	const tui = getToolkitTuiArgv(agentName, task, sessionDir, doneExt);
	if (tui && tui.length > 0) {
		const cmd = tui.map(shellQuote).join(" ");
		return ["bash", "-c", `${osc}; exec ${cmd}`];
	}
	const cli = getToolkitCliCommand(agentName);
	if (!cli) return [];
	const argv = cli.args(task, cwd);
	const cmd = [cli.command, ...argv].map(shellQuote).join(" ");
	return ["bash", "-c", `${osc}; ${cmd} 2>&1 | tee ${shellQuote(rawOutPath)}`];
}

export interface ToolkitDispatchResult {
	exitCode: number;
	raw: string;
	transport: "herdr" | "headless";
	failure?: "timeout" | "cancelled" | "process_error";
}

/**
 * Run an external toolkit CLI. Prefers a sibling Herdr split of the caller
 * pane (same as scout / TEAM), labeled `omp-agent` / `prime-agent`. Falls
 * back to a labeled tab, then to a headless child process.
 */
export async function runToolkitDispatch(opts: {
	agentName: string;
	task: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	sessionDir: string;
	runId: string;
	parentRunId?: string;
	mode?: string;
	timeoutMs?: number;
	journal?: { dir: string; id: string };
	paneTitle: string;
	onProcess?: (proc: any) => void;
	onStdoutLine?: (line: string) => void;
	onStderr?: (chunk: string) => void;
	isCancelled?: () => boolean;
}): Promise<ToolkitDispatchResult> {
	const cancelled = () => !!opts.isCancelled?.();
	const budgetReason = budgetBlockReason();
	if (budgetReason) {
		const message = `Dispatch refused: ${budgetReason}`;
		opts.onStderr?.(message);
		return { exitCode: 122, raw: message, transport: "headless" };
	}
	const estimate = defaultBudgetReservation(opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs + 60_000 : undefined);
	const reservation = estimate ? reserveBudget(opts.journal?.id || opts.runId, estimate.tokens, estimate.costUsd, estimate.ttlMs) : undefined;
	if (activeOrchestrationBudget() && !reservation) {
		const message = "Dispatch refused: shared budget has no available admission reservation";
		opts.onStderr?.(message);
		if (opts.journal) journalUpdate(opts.journal.dir, opts.journal.id, { status: "error", exitCode: 122, note: "reservation_exhausted" });
		return { exitCode: 122, raw: message, transport: "headless", failure: "process_error" };
	}
	const orchestrationRun = createOrchestrationRun({
		eventDir: join(opts.sessionDir, "compositions", opts.runId),
		parentRunId: opts.parentRunId || process.env.PI_AGENT_PI_RUN_ID,
		actor: `toolkit:${opts.agentName}`,
		mode: opts.mode,
		budget: { maxSteps: 1 },
	});
	if (opts.journal) journalUpdate(opts.journal.dir, opts.journal.id, { orchestrationRunId: orchestrationRun.runId });
	orchestrationRun.record("dispatch.started", { launchId: opts.runId, cwd: opts.cwd, agent: opts.agentName, ...(reservation ? { reservationId: reservation.reservationId, reservedTokens: reservation.tokens, reservedCostUsd: reservation.costUsd } : {}) });
	const settleRun = (result: ToolkitDispatchResult): ToolkitDispatchResult => {
		const status = result.exitCode === 130 ? "cancelled" : result.exitCode === 0 ? "succeeded" : "failed";
		orchestrationRun.record("dispatch.completed", { exitCode: result.exitCode, transport: result.transport, ...(result.failure ? { failure: result.failure } : {}) });
		orchestrationRun.finish(status, { exitCode: result.exitCode, transport: result.transport, ...(result.failure ? { failure: result.failure } : {}) });
		return result;
	};
	const stub = { name: opts.agentName, tools: "", systemPrompt: "" };
	const herdrAgent = toolkitHerdrAgent(opts.agentName);
	const herdrLabel = toolkitHerdrLabel(opts.agentName, opts.paneTitle);

	if (await herdrEnabledAsync()) {
		try {
			const wsId = process.env.HERDR_WORKSPACE_ID || await ensureHerdrWorkspaceAsync("agent-pi", opts.cwd);
			if (wsId) {
				mkdirSync(join(opts.sessionDir, "outputs"), { recursive: true });
				const rawPath = join(opts.sessionDir, "outputs", `${opts.runId}.raw`);
				const tuiSessionDir = join(opts.sessionDir, "outputs", `${opts.runId}-session`);
				mkdirSync(tuiSessionDir, { recursive: true });
				const argvVisible = toolkitVisibleCommandLine(
					opts.agentName, opts.task, opts.cwd, rawPath, herdrLabel,
					tuiSessionDir, toolkitHerdrDoneExtPath(),
				);
				if (argvVisible.length > 0) {
					const refs = writeLaunchScript({
						dir: opts.sessionDir,
						id: opts.runId,
						cwd: opts.cwd,
						command: argvVisible,
						env: {
							...opts.env,
							PI_SUBAGENT: "1",
							HERDR_DONE_PATH: launchDonePath(opts.sessionDir, opts.runId),
						PI_WORKER_QUIET: "1",
					},
					});
					const tab = await createHerdrTaskTabAsync(wsId, opts.cwd, herdrLabel);
					if (tab) {
						registerHerdrPane(opts.cwd, {
							key: opts.runId,
							label: herdrLabel,
							cwd: opts.cwd,
							sessionFile: "",
							ref: tab,
							scriptPath: refs.scriptPath,
							donePath: refs.donePath,
							startedPath: refs.startedPath,
							status: "running",
						});
						let herdrCancelled = false;
						opts.onProcess?.({
							kill: () => {
								herdrCancelled = true;
								void closeHerdrTabAsync(tab);
							},
							__piNoExitEvent: true,
						});
						await stampHerdrPaneIdentityAsync(tab, { label: herdrLabel, agent: herdrAgent, state: "working" });
						const sent = await sendCommandToPaneAsync(tab.paneId, ["bash", refs.scriptPath]);
						const started = sent && await waitForLaunchStart(
							refs.startedPath,
							5_000,
							() => herdrCancelled || cancelled(),
						);
						if (started) {
							await stampHerdrPaneIdentityAsync(tab, { label: herdrLabel, agent: herdrAgent, state: "working" });
							const rc = await pollDoneFileAsync(
								refs.donePath,
								opts.timeoutMs === 0 ? DEFAULT_POLL_TIMEOUT_MS : opts.timeoutMs ?? DEFAULT_ORCHESTRATION_TIMEOUT_MS,
								() => herdrCancelled || cancelled(),
							);
							let rawOut = "";
							try { rawOut = readFileSync(rawPath, "utf8"); } catch {}
							try { rmSync(rawPath, { force: true }); } catch {}
							if (!rawOut.trim()) {
								const sessionFile = newestJsonl(tuiSessionDir);
								if (sessionFile) {
									try { rawOut = readFileSync(sessionFile, "utf8"); } catch {}
								}
							}
							cleanupLaunchFiles(refs);
							const cancelledRun = herdrCancelled || cancelled();
							const failed = cancelledRun || rc !== 0;
							await stampHerdrPaneIdentityAsync(tab, {
								label: herdrLabel,
								agent: herdrAgent,
								state: failed ? "unknown" : "idle",
							});
							const autoClose = toolkitHerdrAutoCloseMs(failed ? "error" : "success");
							if (autoClose !== null) {
								scheduleHerdrPaneClose(tab, autoClose);
							}
			return settleRun({
				exitCode: cancelledRun ? 130 : (rc ?? 1),
				raw: rawOut,
				transport: "herdr",
				failure: cancelledRun ? "cancelled" : rc === null ? "timeout" : undefined,
			});
						}
						cleanupLaunchFiles(refs);
						await closeHerdrTabAsync(tab);
						if (herdrCancelled || cancelled()) {
			return settleRun({ exitCode: 130, raw: "", transport: "herdr", failure: "cancelled" });
						}
					}
				}
			}
		} catch {
			// Fall through to the headless CLI.
		}
	}

	const result = await spawnToolkitWorker(stub, {
		task: opts.task,
		cwd: opts.cwd,
		env: opts.env,
		onProcess: opts.onProcess,
		onStdoutLine: opts.onStdoutLine,
		onStderr: opts.onStderr,
		isCancelled: opts.isCancelled,
		timeoutMs: opts.timeoutMs,
	});
	return settleRun({ exitCode: result.exitCode, raw: result.output, transport: "headless", ...(result.failure ? { failure: result.failure } : {}) });
}
