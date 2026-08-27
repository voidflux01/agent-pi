// ABOUTME: Shared toolkit CLI metadata, worker-model resolution, and worker spawning.
// ABOUTME: Toolkit agents represent installed CLI software and should stream real CLI stdout/stderr.

import { spawn } from "child_process";
import { accessSync, constants as fsConstants } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

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

	const args = [
		"--mode", "json",
		"-p",
		"--no-extensions",
		"-e", tasksExtPath,
		"-e", footerExtPath,
		"-e", memoryCycleExtPath,
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
			// pi-family CLI: -p prints and exits; --mode json emits message_end
			// events carrying inline usage (same parser as prime-agent).
			return {
				command: "omp",
				args: (task: string) => ["-p", "--mode", "json", task],
			};
		case "prime-agent":
			return {
				command: "prime-agent",
				// -p prints a response and exits; json mode ends each message with
				// a message_end event carrying inline usage.
				args: (task: string) => ["-p", "--mode", "json", "--no-session", task],
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
			env: { ...process.env, ...options.env, PI_SUBAGENT: "1" },
			cwd: options.cwd,
		});

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
): { text: string; usage?: ToolkitUsage } {
	const name = (agentName || "").toLowerCase();
	try {
		if (name === "prime-agent" || name === "omp-agent") {
			let text = "";
			let usage: ToolkitUsage | undefined;
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
				for (const c of ev?.message?.content ?? []) {
					if (c?.type === "text" && typeof c.text === "string") text += c.text;
				}
			}
			return { text, usage };
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
): string[] {
	const cli = getToolkitCliCommand(agentName);
	if (!cli) return [];
	const argv = cli.args(task, cwd);
	const cmd = [cli.command, ...argv].map(shellQuote).join(" ");
	return ["bash", "-c", `${cmd} 2>&1 | tee ${shellQuote(rawOutPath)}`];
}
