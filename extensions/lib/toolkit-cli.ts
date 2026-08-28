// ABOUTME: Shared toolkit CLI metadata, worker-model resolution, and worker spawning.
// ABOUTME: Toolkit agents represent installed CLI software and should stream real CLI stdout/stderr.

import { spawn } from "child_process";
import { accessSync, constants as fsConstants, mkdirSync, readFileSync, rmSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { childEnvironment } from "./child-runtime.ts";
import { isExplicitDispatchActive } from "./dispatch-gate.ts";
import {
	herdrEnabledAsync,
	ensureHerdrWorkspaceAsync,
	createHerdrTaskTabAsync,
	sendCommandToPaneAsync,
	closeHerdrTabAsync,
	shellQuote as herdrShellQuote,
	writeLaunchScript,
	pollDoneFileAsync,
	waitForLaunchStart,
	cleanupLaunchFiles,
	registerHerdrPane,
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
}

export function isToolkitCliAgent(name: string | undefined | null): boolean {
	if (!name) return false;
	return TOOLKIT_CLI_AGENTS.has(name.toLowerCase());
}

export function resolveToolkitWorkerModel(agentName: string, fallbackModel: string): string {
	return isToolkitCliAgent(agentName) ? TOOLKIT_WORKER_MODEL : fallbackModel;
}

export function getToolkitWorkerArgs(agentDef: ToolkitWorkerAgentDef, options: ToolkitWorkerSpawnOptions): string[] {
	const extDir = dirname(fileURLToPath(import.meta.url));
	const extensionsDir = join(extDir, "..");
	const tasksExtPath = join(extensionsDir, "tasks.ts");
	const footerExtPath = join(extensionsDir, "footer.ts");
	const memoryCycleExtPath = join(extensionsDir, "memory-cycle.ts");
	const nudgeListenerExtPath = join(extensionsDir, "nudge-listener.ts");
	const securityGuardExtPath = join(extensionsDir, "security-guard.ts");

	const args = [
		"--mode", "json",
		"-p",
		"--no-extensions",
		"-e", securityGuardExtPath,
		"-e", tasksExtPath,
		"-e", footerExtPath,
		"-e", memoryCycleExtPath,
		"-e", nudgeListenerExtPath,
		"--model", TOOLKIT_WORKER_MODEL,
		"--tools", agentDef.tools,
		"--thinking", "off",
		"--append-system-prompt", agentDef.systemPrompt,
	];

	if (options.sessionFile) {
		args.push("--session", options.sessionFile);
	}

	args.push(options.task);
	return args;
}

/** Opt in to a bare CLI: no discovered extensions or skills. Default is off so
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
					...(toolkitBareMode() ? ["--no-extensions", "--no-skills"] : []),
					task,
				],
			};
		case "prime-agent":
			return {
				command: "prime-agent",
				args: (task: string) => [
					"-p", "--mode", "json", "--no-session",
					...(toolkitBareMode() ? ["-ne", "-ns"] : []),
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
		const proc = spawn(resolveCommandPath(command), args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: childEnvironment({ ...options.env, PI_SUBAGENT: "1" }),
			cwd: options.cwd,
		});
		options.onProcess?.(proc);

		const startTime = Date.now();
		let output = "";
		let buffer = "";

		proc.stdout?.setEncoding("utf-8");
		proc.stdout?.on("data", (chunk: string) => {
			output += chunk;
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (line.trim()) options.onStdoutLine?.(line);
			}
		});

		proc.stderr?.setEncoding("utf-8");
		proc.stderr?.on("data", (chunk: string) => {
			output += chunk;
			if (chunk) options.onStderr?.(chunk);
			const lines = chunk.split("\n");
			for (const line of lines) {
				if (line.trim()) options.onStdoutLine?.(line);
			}
		});

		const finishWith = (exitCode: number, outText: string) => {
			resolve({
				exitCode,
				elapsed: Date.now() - startTime,
				output: outText,
			});
		};

		const retryWithPureArgsOr = (fallback: () => void) => {
			if (cliCommand?.pureArgs && attempts.length === 0) {
				attempts.push(cliCommand.pureArgs(options.task, options.cwd));
				output = "";
				buffer = "";
				runAttempt();
				return;
			}
			fallback();
		};

		proc.on("error", (err) => {
			const msg = `CLI spawn error (${command}): ${err.message}`;
			options.onStderr?.(msg);
			options.onStdoutLine?.(msg);
			retryWithPureArgsOr(() => finishWith(1, msg));
		});

		proc.on("close", (code) => {
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

/**
 * Shell command line that runs an external CLI visibly inside a herdr pane:
 * stdout AND stderr stream live in the pane while tee'ing the JSON event
 * stream (or plain output) to rawOutPath for authoritative result parsing.
 */
export function toolkitVisibleCommandLine(
	agentName: string,
	task: string,
	cwd: string | undefined,
	rawOutPath: string,
	paneTitle?: string,
): string[] {
	const cli = getToolkitCliCommand(agentName);
	if (!cli) return [];
	const argv = cli.args(task, cwd);
	const cmd = [cli.command, ...argv].map(shellQuote).join(" ");
	const title = (paneTitle || toolkitRuntimeName(agentName) || agentName)
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.slice(0, 40);
	return ["bash", "-c", `printf '\\033]0;${title}\\007'; ${cmd} 2>&1 | tee ${shellQuote(rawOutPath)}`];
}

export interface ToolkitDispatchResult {
	exitCode: number;
	raw: string;
	transport: "herdr" | "headless";
}

/**
 * Run an external toolkit CLI. Prefers a watchable Herdr sibling pane
 * (same as TEAM dispatch); falls back to a headless child process.
 */
export async function runToolkitDispatch(opts: {
	agentName: string;
	task: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	sessionDir: string;
	runId: string;
	paneTitle: string;
	onProcess?: (proc: any) => void;
	onStdoutLine?: (line: string) => void;
	onStderr?: (chunk: string) => void;
	isCancelled?: () => boolean;
}): Promise<ToolkitDispatchResult> {
	const cancelled = () => !!opts.isCancelled?.();
	const stub = { name: opts.agentName, tools: "", systemPrompt: "" };

	if (await herdrEnabledAsync()) {
		try {
			const wsId = process.env.HERDR_WORKSPACE_ID || await ensureHerdrWorkspaceAsync("agent-pi", opts.cwd);
			if (wsId) {
				mkdirSync(join(opts.sessionDir, "outputs"), { recursive: true });
				const rawPath = join(opts.sessionDir, "outputs", `${opts.runId}.raw`);
				const argvVisible = toolkitVisibleCommandLine(opts.agentName, opts.task, opts.cwd, rawPath, opts.paneTitle);
				if (argvVisible.length > 0) {
					const refs = writeLaunchScript({
						dir: opts.sessionDir,
						id: opts.runId,
						cwd: opts.cwd,
						command: argvVisible,
						env: { ...opts.env, PI_SUBAGENT: "1" },
					});
					const tab = await createHerdrTaskTabAsync(wsId, opts.cwd, opts.paneTitle);
					if (tab) {
						registerHerdrPane(opts.cwd, {
							key: opts.runId,
							label: opts.paneTitle,
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
						const sent = await sendCommandToPaneAsync(tab.paneId, `bash ${herdrShellQuote(refs.scriptPath)}`);
						const started = sent && await waitForLaunchStart(
							refs.startedPath,
							5_000,
							() => herdrCancelled || cancelled(),
						);
						if (started) {
							const rc = await pollDoneFileAsync(
								refs.donePath,
								7 * 24 * 3600 * 1000,
								() => herdrCancelled || cancelled(),
							);
							cleanupLaunchFiles(refs);
							await closeHerdrTabAsync(tab);
							let rawOut = "";
							try { rawOut = readFileSync(rawPath, "utf8"); } catch {}
							try { rmSync(rawPath, { force: true }); } catch {}
							return {
								exitCode: herdrCancelled || cancelled() ? 130 : (rc ?? 1),
								raw: rawOut,
								transport: "herdr",
							};
						}
						cleanupLaunchFiles(refs);
						await closeHerdrTabAsync(tab);
						if (herdrCancelled || cancelled()) {
							return { exitCode: 130, raw: "", transport: "herdr" };
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
	});
	return { exitCode: result.exitCode, raw: result.output, transport: "headless" };
}
