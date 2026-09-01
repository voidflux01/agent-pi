// ABOUTME: Spawns and manages background subagent processes with live status widgets.
// ABOUTME: Provides /sub, /subcont, /subrm, /subclear commands and subagent_* tools.
/**
 * Subagent Widget — /sub, /subclear, /subrm, /subcont commands with stacking live widgets
 *
 * Each /sub spawns a background Pi subagent with its own persistent session,
 * enabling conversation continuations via /subcont.
 *
 * Usage: pi -e extensions/subagent-widget.ts
 * Then:
 *   /sub list files and summarize          — spawn a new subagent
 *   /subcont 1 now write tests for it      — continue subagent #1's conversation
 *   /subrm 2                               — remove subagent #2 widget
 *   /subclear                              — clear all subagent widgets
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerToolWithExecutor } from "./lib/tool-executor-registry.ts";
import { Box, Text, type AutocompleteItem } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { applyExtensionDefaults } from "./lib/themeMap.ts";
import { formatDuration } from "./lib/duration-format.ts";
import { childEnvironment, ensurePiTool } from "./lib/child-runtime.ts";
import { subagentContextBudget } from "./lib/context-budget.ts";
import { renderSubagentWidget, parseSubName, shouldScheduleWidgetRemoval } from "./lib/subagent-render.ts";
import { DEFAULT_SUBAGENT_MODEL } from "./lib/defaults.ts";
import { cleanOldSessionFiles } from "./lib/subagent-cleanup.ts";
import { buildCommanderPrompt } from "./lib/commander-prompt.ts";
import { preClaimTask, postCompleteTask, postFailTask } from "./lib/commander-lifecycle.ts";
import { parseGroupCreateResult, buildGroupCreatePayload } from "./lib/commander-sync.ts";
import { scanAgentDefs, scanToolkitAgentDefs, resolveAgentByName, loadAgentModelsConfig, loadToolkitModelsConfig, resolveAgentModelString, type AgentDef, type AgentModelsConfig } from "./lib/agent-defs.ts";
import { resolveToolkitWorkerModel, isToolkitCliAgent, parseToolkitResult, toolkitRuntimeName, runToolkitDispatch } from "./lib/toolkit-cli.ts";
import { buildMailboxPreamble, mailboxPreambleEnabled } from "./lib/fleet-mailbox.ts";
import { currentDispatchAuthorization, isExplicitDispatchActive, run as runDispatch, explicitDispatchHandler, withSessionLifecycle, type DispatchFailure } from "./lib/dispatch-runtime.ts";
import { commanderAvailable as commanderAvailableState, commanderClient } from "./lib/coordination-state.ts";
import { buildAgentResultContractPrompt, checkResultCompliance, composeAgentResult, contractGateEnabled, persistFullOutput, runBaseName } from "./lib/agent-result-contract.ts";
import { journalAppend, journalUpdate, pruneRunArtifacts, reconcileJournal } from "./lib/agent-task-journal.ts";
import { readLastAssistantText, sessionUsage, countSessionToolCalls, updateHerdrPaneStatus, registerHerdrCommands, herdrWorkerLabel } from "./lib/herdr-client.ts";
import { shouldAwaitSubagentResult } from "./lib/task-gate.ts";
import { applyWorkerLaunchPolicy, implementationWorkerPrompt, isExecutionWorker } from "./lib/worker-budget.ts";
import { discoverResearchTools } from "./lib/research-protocol.ts";

// ── Commander availability ───────────────────────────────────────────────────

function isCommanderAvailable(): boolean {
	return commanderAvailableState();
}

function getCommanderClient(): any | undefined {
	return isCommanderAvailable() ? commanderClient() : undefined;
}

// ── Graceful kill helper ─────────────────────────────────────────────────────

/** Send SIGTERM and wait up to `timeoutMs` for exit; escalate to SIGKILL. */
function killGracefully(proc: any, timeoutMs = 3000): Promise<void> {
	return new Promise((resolve) => {
		if (!proc) {
			resolve();
			return;
		}
		// Herdr uses a lightweight close-pane handle with no exit event.
		if (proc.__piNoExitEvent) {
			try { proc.kill(); } catch {}
			resolve();
			return;
		}
		if (proc.exitCode !== null && proc.exitCode !== undefined) {
			resolve();
			return;
		}
		let settled = false;
		const onExit = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve();
		};
		proc.once("exit", onExit);
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			proc.removeListener("exit", onExit);
			try { proc.kill("SIGKILL"); } catch {}
			resolve();
		}, timeoutMs);
		// Install the fallback before SIGTERM: some test doubles and very small
		// children emit `exit` synchronously from kill().
		try { proc.kill("SIGTERM"); } catch { onExit(); }
	});
}

/** Grace period after SIGTERM before escalating to SIGKILL. */
const TIMEOUT_KILL_GRACE_MS = 30_000;

/** Optional explicit timeout only. 0 / omitted means no watchdog kill. */
export function resolveTimeout(_name: string, explicitTimeout?: number): number {
	if (explicitTimeout !== undefined && explicitTimeout >= 0) return explicitTimeout;
	return 0;
}

/** Toolkit harnesses keep lowercase names so herdr labels match `omp-agent`. */
export function displayAgentName(name: string | undefined): string {
	const raw = name || "AGENT";
	return isToolkitCliAgent(raw) ? raw.toLowerCase() : raw.toUpperCase();
}

interface SubState {
	id: number;
	status: "running" | "done" | "error";
	name: string;          // short role label, e.g. "SCOUT", "REVIEWER"
	task: string;
	textChunks: string[];
	toolCount: number;
	elapsed: number;
	sessionFile: string;   // persistent JSONL session path — used by /subcont to resume
	turnCount: number;     // increments each time /subcont continues this agent
	summary?: string;      // pre-written summary shown in widget (no markdown)
	proc?: any;            // active ChildProcess ref (for kill on /subrm)
	commanderTaskId?: number;  // pre-assigned Commander task ID
	autoRemove?: boolean;      // auto-remove widget ~30s after done (default: true)
	model?: string;            // resolved model string for display
	saRunId?: string;      // task-journal row id for this dispatch (= output file base)
	maxDurationMs: number;     // watchdog timeout — kills agent after this duration
	resultBudgetChars?: number; // parent-visible result budget, scaled by context usage
	watchdogTimer?: ReturnType<typeof setTimeout>; // reference to clear on normal exit
	elapsedTimer?: ReturnType<typeof setInterval>; // live widget timer, cleared on lifecycle changes
	/** When true, the parent tool waits for RESULT and skips the follow-up turn. */
	awaitResult?: boolean;
}

export default function (pi: ExtensionAPI) {
	const agents: Map<number, SubState> = new Map();
	let nextId = 1;
	let widgetCtx: any;
	// Incremented whenever the parent session is replaced. Background child
	// processes can finish after that point, but must not touch the old ctx.
	let sessionEpoch = 0;
	const widgetBoxes = new Map<number, { invalidate: () => void }>();

	function contextCwd(ctx: any): string {
		// Reading cwd from a context after session replacement throws, even with
		// optional chaining. Snapshot it while the context is known to be live.
		try { return ctx?.cwd || process.cwd(); } catch { return process.cwd(); }
	}

	function notifyCurrent(message: string, level: string): void {
		// Timers and child-process callbacks outlive the ctx that started them.
		// The current context may also disappear during extension reload.
		try { widgetCtx?.ui?.notify?.(message, level); } catch {}
	}

	function clearWidgetCurrent(key: string): void {
		try { widgetCtx?.ui?.setWidget?.(key, undefined); } catch {}
	}

	// ── Agent definition registry (loaded from .md files + models.json) ───────
	// Maps lowercase agent names to their definitions. Model assignments come from
	// .pi/agents/models.json — not from .md frontmatter. When subagent_create is
	// called with a name matching a known agent, we auto-apply that agent's
	// configured model, tools, and system prompt.
	let knownAgents: Map<string, AgentDef> = new Map();
	let modelsConfig: AgentModelsConfig | null = null;

	// ── Session file helpers ──────────────────────────────────────────────────

	function makeSessionFile(id: number): string {
		const dir = path.join(os.homedir(), ".pi", "agent", "sessions", "subagents");
		fs.mkdirSync(dir, { recursive: true });
		return path.join(dir, `subagent-${id}-${Date.now()}.jsonl`);
	}

	// ── Widget rendering ──────────────────────────────────────────────────────

	// ── Dark background colors for subagent status ───────────────────────────
	// Standard dark shades that keep white text readable on any terminal.
	const STATUS_BG: Record<string, string> = {
		running: "\x1b[48;2;26;58;92m",   // dark steel blue
		done:    "\x1b[48;2;35;50;55m",    // dark teal-gray
		error:   "\x1b[48;2;70;35;35m",    // dark muted red
	};
	const RESET_BG = "\x1b[49m";
	const WHITE_BOLD = "\x1b[1;97m";  // bold bright white text
	const RESET_ALL = "\x1b[0m";

	function registerWidget(state: SubState) {
		if (!widgetCtx) return;
		const key = `sub-${state.id}`;
		widgetCtx.ui.setWidget(key, (_tui: any, theme: any) => {
			const bgFn = (text: string): string => {
				const bg = STATUS_BG[state.status] || STATUS_BG.running;
				return `${bg}${WHITE_BOLD}${text}${RESET_ALL}${RESET_BG}`;
			};

			const box = new Box(1, 1, bgFn);
			const content = new Text("", 0, 0);
			box.addChild(content);
			widgetBoxes.set(state.id, { invalidate: () => box.invalidate() });

			return {
				render(width: number): string[] {
					box.setBgFn((text: string): string => {
						const bg = STATUS_BG[state.status] || STATUS_BG.running;
						return `${bg}${WHITE_BOLD}${text}${RESET_ALL}${RESET_BG}`;
					});

					const result = renderSubagentWidget(state, width, theme);
					content.setText(result.lines.join("\n"));
					return box.render(width);
				},
				invalidate() {
					box.invalidate();
				},
			};
		});
	}

	function invalidateWidget(id: number) {
		widgetBoxes.get(id)?.invalidate();
	}

	// ── Streaming helpers ─────────────────────────────────────────────────────

	function processLine(state: SubState, line: string) {
		if (!line.trim()) return;
		try {
			const event = JSON.parse(line);
			const type = event.type;

			if (type === "message_update") {
				const delta = event.assistantMessageEvent;
				if (delta?.type === "text_delta") {
					state.textChunks.push(delta.delta || "");
					invalidateWidget(state.id);
				}
			} else if (type === "tool_execution_start") {
				state.toolCount++;
				invalidateWidget(state.id);
			}
		} catch {}
	}

	function spawnAgent(
		state: SubState,
		prompt: string,
		ctx: any,
		peerNames?: string[],
	): Promise<string> {
		// Snapshot all session-bound values before any asynchronous work starts.
		// A child may finish after /new, /resume, or extension reload, at which
		// point dereferencing the captured ctx throws and can kill pi.
		if (!isExplicitDispatchActive()) {
			const message = "Subagent dispatch refused: only an explicit tool or slash command may start a child";
			state.status = "error";
			state.summary = message;
			notifyCurrent(message, "error");
			return Promise.resolve(message);
		}

		notifyCurrent(`SA${state.id} (${state.name}) started`, "info");

		const spawnCwd = contextCwd(ctx);
		const spawnEpoch = sessionEpoch;

		// Model resolution priority:
		// 1) Caller-specified override (state.model set by tool call)
		// 2) Agent definition model (from .md file, resolved via models.json)
		// 3) models.json agent entry (even without .md file)
		// 4) models.json default entry
		const agentDef = resolveAgentByName(state.name, knownAgents);
		const configModel = modelsConfig ? resolveAgentModelString(state.name, modelsConfig) : undefined;
		const model = resolveToolkitWorkerModel(
			state.name,
			state.model || agentDef?.model || configModel || DEFAULT_SUBAGENT_MODEL,
		);
		if (!isToolkitCliAgent(state.name)) state.model = model;
		const contextUsage = ctx?.getContextUsage?.();
		state.resultBudgetChars = subagentContextBudget(contextUsage?.percent, 1).resultChars;

		// Journal the dispatch — id doubles as the archived-transcript base name.
		const saDir = path.join(spawnCwd, ".pi", "agent-sessions");
		const saBase = runBaseName(`${state.name.toLowerCase()}-sa${state.id}`, state.turnCount);
		state.saRunId = saBase;
		journalAppend(saDir, {
			version: 1,
			id: saBase,
			kind: "sa",
			agent: state.name.toLowerCase(),
			runtime: toolkitRuntimeName(state.name),
			task: prompt,
			model: isToolkitCliAgent(state.name) ? undefined : (state.model || undefined),
			sessionFile: isToolkitCliAgent(state.name) ? undefined : state.sessionFile,
			status: "dispatched",
			startedAt: Date.now(),
			updatedAt: Date.now(),
		});

		const extDir = path.dirname(fileURLToPath(import.meta.url));

		// Commander integration
		const commanderAvail = isCommanderAvailable();
		const cmdTaskId = state.commanderTaskId;

		// Tools: use agent definition tools if available, else default set
		let tools = agentDef?.tools || "read,bash,grep,find,ls";
		if (state.name.toLowerCase() === "researcher") {
			for (const name of discoverResearchTools(pi.getAllTools())) tools = ensurePiTool(tools, name);
		}
		if (!isToolkitCliAgent(state.name)) tools = ensurePiTool(tools, "ask_parent");
		// Loaded only by the visible herdr transport: writes the pane's done marker
		// on the child's first agent_end, since an interactive worker stays alive
		// after finishing its task.
		const herdrDoneExtPath = path.join(extDir, "herdr-done.ts");

		// Build system prompt: agent definition prompt + Commander discipline
		// Build one stable prompt block instead of several append flags. This keeps
		// the worker's system-prefix reusable for provider prompt caching and avoids
		// repeating the same framing between runtime adapters.
		const promptParts: string[] = [];
		if (agentDef?.systemPrompt) promptParts.push(agentDef.systemPrompt);
		if (commanderAvail) {
			promptParts.push(buildCommanderPrompt({
				agentName: `SA-${state.id}-${state.name}`,
				taskId: cmdTaskId,
				enableMailboxChat: true,
				peerNames,
			}));
		}
		if (!isToolkitCliAgent(state.name)) {
			promptParts.push(buildAgentResultContractPrompt());
			if (isExecutionWorker(state.name)) promptParts.push(implementationWorkerPrompt());
		}
		const systemPromptArgs = ["--append-system-prompt", promptParts.join("\n\n")];

		// Pre-claim: parent claims Commander task on behalf of subagent
		if (commanderAvail && cmdTaskId !== undefined) {
			const client = getCommanderClient();
			if (client) {
				preClaimTask(client, cmdTaskId, `SA-${state.id}-${state.name}`).catch(() => {});
			}
		}

		// Mailbox identity must follow the visible SA id, not the role name:
		// multiple SCOUT/BUILDER workers can run at the same time.
		const mailboxAgent = `sa${state.id}`;
		const paneTitle = herdrWorkerLabel(
			isToolkitCliAgent(state.name) ? state.name.toLowerCase() : state.name,
			`sa${state.id}`,
		);
		const spawnEnv: Record<string, string | undefined> = childEnvironment({
			PI_SUBAGENT: "1",
			PI_AGENT_NAME: mailboxAgent,
			PI_PANE_TITLE: paneTitle,
			PI_SESSION_FILE: state.sessionFile,
		});
		if (commanderAvail && cmdTaskId !== undefined) {
			spawnEnv.PI_COMMANDER_TASK_ID = String(cmdTaskId);
		}

		return new Promise<string>((resolve) => {
			const startTime = Date.now();
			const timer = setInterval(() => {
				if (spawnEpoch !== sessionEpoch) {
					clearInterval(timer);
					return;
				}
				state.elapsed = Date.now() - startTime;
				if (state.sessionFile) {
					const n = countSessionToolCalls(state.sessionFile);
					if (n > state.toolCount) state.toolCount = n;
				}
				invalidateWidget(state.id);
			}, 1000);
			state.elapsedTimer = timer;

			// ── Watchdog: kill agent if it exceeds maxDurationMs ──────────
			if (state.maxDurationMs > 0) {
				state.watchdogTimer = setTimeout(() => {
					if (state.status !== "running") return; // already finished
					if (spawnEpoch !== sessionEpoch) return;
					const mins = Math.round(state.maxDurationMs / 60_000);
					state.textChunks.push(`\n[TIMEOUT] Agent timed out after ${mins} minutes.`);
					notifyCurrent(`SA${state.id} (${state.name}) timed out after ${mins}m`, "warning");
					if (state.proc) {
						killGracefully(state.proc, TIMEOUT_KILL_GRACE_MS).catch(() => {});
					}
				}, state.maxDurationMs);
			}

			let finished = false;
			const finish = (code: number | null, externalFull?: string, externalUsage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; costUsd: number }, failure?: DispatchFailure) => {
				if (finished) return;
				finished = true;
				clearInterval(timer);
				if (state.elapsedTimer === timer) state.elapsedTimer = undefined;
				// Clear watchdog — agent exited normally before timeout
				if (state.watchdogTimer) {
					clearTimeout(state.watchdogTimer);
					state.watchdogTimer = undefined;
				}
				// The child belongs to the replaced session. Finish timer cleanup,
				// then stop before mutating its state or touching any session-bound UI.
				if (spawnEpoch !== sessionEpoch) {
					const staleJournalDir = path.join(spawnCwd, ".pi", "agent-sessions");
					try {
						journalUpdate(staleJournalDir, state.saRunId ?? "", {
							status: "error",
							runStatus: "cancelled",
							exitCode: code ?? 130,
							elapsedMs: Date.now() - startTime,
							note: "cancelled: parent session changed",
						});
					} catch {}
					resolve(`SA${state.id} (${state.name}) cancelled because the parent session changed.`);
					return;
				}
				state.elapsed = Date.now() - startTime;
				state.status = code === 0 && !failure ? "done" : "error";
				state.proc = undefined;
				if (state.toolCount === 0 && state.sessionFile) {
					state.toolCount = countSessionToolCalls(state.sessionFile);
				}
				updateHerdrPaneStatus(
					spawnCwd,
					`sa-${state.id}`,
					code === 0 && !failure ? "done" : "error",
				);
				invalidateWidget(state.id);

				// Post-dispatch: reconcile Commander task to terminal state
				if (commanderAvail && cmdTaskId !== undefined) {
					const client = getCommanderClient();
					if (client) {
						const agentLabel = `SA-${state.id}-${state.name}`;
						const summary = state.textChunks.join("").trim().split("\n").pop() || agentLabel;
						if (state.status === "done") {
							postCompleteTask(client, cmdTaskId, agentLabel, summary).catch(() => {});
						} else {
							const errMsg = summary || "Agent exited with error";
							postFailTask(client, cmdTaskId, errMsg).catch(() => {});
						}
					}
				}

				const result = externalFull ?? state.textChunks.join("");

				// Archive the FULL transcript like team/chain/pipeline runs do,
				// so long results survive the 8k follow-up message cap.
				let fullOutputPath = "";
				const saOutDir = path.join(spawnCwd, ".pi", "agent-sessions");
				try {
					fullOutputPath = persistFullOutput(
						saOutDir,
						state.saRunId ?? runBaseName(`${state.name.toLowerCase()}-sa${state.id}`, state.turnCount),
						result,
					);
				} catch {}
				const toolkitRun = isToolkitCliAgent(state.name);
				let contractProblems: string[] = [];
				if (!toolkitRun) {
					try {
						const compliance = checkResultCompliance(result);
						contractProblems = compliance.ok ? [] : compliance.problems;
					} catch {}
				}
				try {
					const saUsage = externalUsage ?? sessionUsage(state.sessionFile);
					journalUpdate(saOutDir, state.saRunId ?? "", {
						status: code === 0 && !failure ? "done" : "error",
						exitCode: code,
						elapsedMs: state.elapsed,
						model: state.model || undefined,
						outputFile: fullOutputPath || undefined,
						note: [failure ? `dispatch: ${failure}` : "", contractProblems.length > 0 ? `result contract: ${contractProblems.join("; ")}` : ""].filter(Boolean).join("; ") || undefined,
						usage: (externalUsage ?? saUsage).totalTokens > 0 ? {
							input: saUsage.input,
							output: saUsage.output,
							cacheRead: saUsage.cacheRead,
							cacheWrite: saUsage.cacheWrite,
							totalTokens: saUsage.totalTokens,
							costUsd: Math.round(saUsage.costUsd * 1e6) / 1e6,
						} : undefined,
					});
				} catch {}

				notifyCurrent(
					`SA${state.id} (${state.name}) ${state.status} in ${formatDuration(state.elapsed)}`,
					state.status === "done" ? "success" : "error"
				);

				const compactResult = composeAgentResult({
					agent: `SA${state.id} (${state.name})`,
					status: state.status,
					exitCode: code,
					elapsedMs: state.elapsed,
					model: state.model,
					outputText: result,
					fullOutputPath,
					maxResultChars: state.resultBudgetChars,
					skipContract: toolkitRun,
				});
				if (!state.awaitResult) {
					try {
						void pi.sendMessage({
							customType: "subagent-result",
							content: `${compactResult.content}\n\nTask: ${prompt.slice(0, 1200)}${prompt.length > 1200 ? "… [task truncated]" : ""}`,
							display: true,
						}, { deliverAs: "steer", triggerTurn: true }).catch(() => {});
					} catch {}
				}

				// Auto-remove completed widgets after 30s (default behavior).
				if (shouldScheduleWidgetRemoval(state, false)) {
					setTimeout(() => {
						if (spawnEpoch !== sessionEpoch) return;
						if (agents.has(state.id) && state.status !== "running") {
							clearWidgetCurrent(`sub-${state.id}`);
							widgetBoxes.delete(state.id);
							agents.delete(state.id);
						}
					}, 30_000);
				}

				resolve(compactResult.content);
			};

			// argv for the headless path. The visible herdr transport derives its
			// watchable variant from `["pi", ...argv]` via visiblePiTuiCommand().
			const argv = [
				"--mode", "json",
				"-p",
				"--session", state.sessionFile,
				"--model", model,
				"--tools", tools,
				...systemPromptArgs,
				prompt,
			];

			if (isToolkitCliAgent(state.name)) {
				const extTask0 = mailboxPreambleEnabled() ? `${buildMailboxPreamble(mailboxAgent, spawnCwd)}\n\n---\n\n${prompt}` : prompt;
				void runToolkitDispatch({
					agentName: state.name,
					task: extTask0,
					cwd: spawnCwd,
					env: spawnEnv,
					sessionDir: saDir,
					runId: state.saRunId ?? `sa${state.id}`,
					paneTitle,
					onProcess: (proc: any) => {
						if (spawnEpoch === sessionEpoch) state.proc = proc;
					},
					onStdoutLine: (line: string) => {
						if (spawnEpoch === sessionEpoch) processLine(state, line);
					},
					onStderr: (chunk: string) => {
						if (spawnEpoch !== sessionEpoch) return;
						if (chunk.trim()) {
							state.textChunks.push(chunk);
							invalidateWidget(state.id);
						}
					},
					isCancelled: () => spawnEpoch !== sessionEpoch,
				}).then(({ exitCode, raw }) => {
					const parsed = parseToolkitResult(state.name, raw);
					if (parsed.model) state.model = parsed.model;
					finish(exitCode, parsed.text || raw || undefined, parsed.usage);
				}).catch(() => finish(1));
				return;
			}

			// Standard Pi transport is shared with team, chain, and pipeline. The
			// widget keeps watchdog, epoch, Commander, and follow-up policies local.
			const launch = applyWorkerLaunchPolicy(["pi", ...argv], state.name);
			runDispatch({
				authorization: currentDispatchAuthorization(),
				command: launch.command,
				cwd: spawnCwd,
				env: spawnEnv,
				launchDir: path.dirname(state.sessionFile),
				launchId: `sa${state.id}`,
				sessionFile: state.sessionFile,
				herdrDoneExtPath,
				herdrLabel: paneTitle,
				herdrPaneKey: `sa-${state.id}`,
				journal: { dir: saDir, id: state.saRunId ?? "" },
				isAborted: () => spawnEpoch !== sessionEpoch,
				onProcess: (child) => {
					if (spawnEpoch === sessionEpoch) state.proc = child as any;
				},
				onStdoutLine: (line) => {
					if (spawnEpoch === sessionEpoch) processLine(state, line);
				},
				onStderr: (chunk) => {
					if (spawnEpoch !== sessionEpoch) return;
					if (chunk.trim()) {
						state.textChunks.push(chunk);
						invalidateWidget(state.id);
					}
				},
				onHerdrUpdate: () => {
					if (spawnEpoch !== sessionEpoch) return;
					try {
						const { text } = readLastAssistantText(state.sessionFile);
						const last = text.split("\n").filter((l: string) => l.trim()).pop() || "";
						if (last) {
							state.summary = last;
							invalidateWidget(state.id);
						}
					} catch {}
				},
			}).then((result) => {
				finish(result.exitCode, result.outputText, undefined, result.failure);
			}).catch(() => finish(1));
		});
	}

		// ── Tools for the Main Agent ──────────────────────────────────────────────

	registerToolWithExecutor(pi, {
		name: "subagent_create",
		description: "Spawn a subagent to perform a task. When `name` is scout, this call blocks until that scout finishes and returns its RESULT — treat that ## RESULT as the report, do not read the archived transcript unless a path is missing, and do not start overlapping reconnaissance in the same turn. Toolkit CLIs (omp-agent, prime-agent, and other named harnesses) also block until the CLI exits; do not poll with subagent_list or sleep. Other roles return the subagent ID immediately and deliver results as a follow-up message when finished.\n\nWhen `name` matches a known agent definition (scout, builder, reviewer, planner, tester, red-team, omp-agent, prime-agent), that agent's configured model, tools, and system prompt are automatically applied. Only set `model` to override the agent's default.",
		parameters: Type.Object({
			task: Type.String({ description: "The complete task description for the subagent to perform" }),
			name: Type.Optional(Type.String({ description: "Short role label (e.g. REVIEWER, SCOUT). If this matches a known agent definition, that agent's model/tools/prompt are auto-applied." })),
			summary: Type.Optional(Type.String({ description: "Short summary shown in widget (no markdown)" })),
			model: Type.Optional(Type.String({ description: "Model override. Only set this to override the agent's default model. If omitted, uses the agent definition's model or the system default." })),
			commanderTaskId: Type.Optional(Type.Number({ description: "Pre-assigned Commander task ID (avoids race conditions)" })),
			autoRemove: Type.Optional(Type.Boolean({ description: "Auto-remove widget ~30s after done (default: true)" })),
			timeout: Type.Optional(Type.Number({ description: "Optional max runtime in milliseconds. Omit or 0 to run until the agent finishes." })),
		}),
		execute: async (callId, args, _signal, _onUpdate, ctx) => {
			widgetCtx = ctx;
			const contextUsage = ctx?.getContextUsage?.();
			const budget = subagentContextBudget(contextUsage?.percent, 1);
			if (budget.maxAgents === 0) {
				return { content: [{ type: "text", text: `Context is at ${Math.round(contextUsage?.percent ?? 90)}%; defer subagent work until after compaction.` }] };
			}
			const id = nextId++;
			const agentName = displayAgentName(args.name);
			const awaitResult = shouldAwaitSubagentResult(agentName);
			const state: SubState = {
				id,
				status: "running",
				name: agentName,
				task: args.task,
				textChunks: [],
				toolCount: 0,
				elapsed: 0,
				sessionFile: makeSessionFile(id),
				turnCount: 1,
				summary: args.summary,
				commanderTaskId: args.commanderTaskId,
				autoRemove: args.autoRemove,
				model: args.model, // caller-specified model override
				maxDurationMs: resolveTimeout(agentName, args.timeout),
				awaitResult,
			};
			agents.set(id, state);
			registerWidget(state);

			const started = explicitDispatchHandler("subagent-tool", () => spawnAgent(state, args.task, ctx))();
			if (!awaitResult) {
				return {
					content: [{ type: "text", text: `SA${id} (${state.name}) spawned and running in background.` }],
				};
			}
			const result = await started;
			return {
				content: [{ type: "text", text: result || `SA${id} (${state.name}) finished with no output.` }],
			};
		},
	});

	registerToolWithExecutor(pi, {
		name: "subagent_create_batch",
		description: "Spawn multiple subagents at once with optional Commander task group. Pre-creates Commander tasks to avoid race conditions where multiple agents try to claim the same task.\n\nWhen an agent's `name` matches a known agent definition, that agent's configured model, tools, and system prompt are automatically applied.",
		parameters: Type.Object({
			agents: Type.Array(Type.Object({
				task: Type.String({ description: "The complete task description for the subagent" }),
				name: Type.Optional(Type.String({ description: "Short role label (e.g. REVIEWER, SCOUT). If this matches a known agent definition, that agent's model/tools/prompt are auto-applied." })),
				summary: Type.Optional(Type.String({ description: "Short summary shown in widget (no markdown)" })),
				model: Type.Optional(Type.String({ description: "Model override. Only set to override the agent definition's default model." })),
			}), { description: "Array of agent definitions to spawn" }),
			groupName: Type.Optional(Type.String({ description: "Commander task group name (used when Commander is available)" })),
			autoRemove: Type.Optional(Type.Boolean({ description: "Auto-remove widgets ~30s after done (default: true)" })),
			timeout: Type.Optional(Type.Number({ description: "Optional max runtime in ms for every agent in this batch. Omit or 0 to run until each agent finishes." })),
			force: Type.Optional(Type.Boolean({ description: "Force spawn even if agents are already running (default: false)" })),
		}),
		execute: async (callId, args, _signal, _onUpdate, ctx) => {
			widgetCtx = ctx;
			const commandEpoch = sessionEpoch;
			const requestedDefs = args.agents;
			if (!requestedDefs || requestedDefs.length === 0) {
				return { content: [{ type: "text", text: "Error: No agents specified." }] };
			}
			const contextUsage = ctx?.getContextUsage?.();
			const budget = subagentContextBudget(contextUsage?.percent, requestedDefs.length);
			if (budget.maxAgents === 0) {
				return { content: [{ type: "text", text: `Context is at ${Math.round(contextUsage?.percent ?? 90)}%; defer batch spawning until after compaction.` }] };
			}
			const defs = requestedDefs.slice(0, budget.maxAgents);
			const deferred = requestedDefs.length - defs.length;
	
			// ── Guard: prevent duplicate batch spawns while agents are running ──
			if (!args.force) {
				const running = Array.from(agents.values()).filter(a => a.status === "running");
				if (running.length > 0) {
					const names = running.map(a => `SA${a.id} (${a.name})`).join(", ");
					return {
						content: [{ type: "text", text: `Warning: ${running.length} agent(s) still running: ${names}. Wait for them to finish, use subagent_cleanup to clear stale agents, or pass force: true to override.` }],
					};
				}
			}

			// ── Auto-cleanup: remove done/error agents before spawning new batch ──
			for (const [id, a] of Array.from(agents.entries())) {
				if (a.status === "done" || a.status === "error") {
					if (widgetCtx) widgetCtx.ui.setWidget(`sub-${id}`, undefined);
					widgetBoxes.delete(id);
					agents.delete(id);
				}
			}

			// Build states for all agents
			const states: SubState[] = defs.map((def: any) => {
				const id = nextId++;
				const agentName = displayAgentName(def.name);
				return {
					id,
					status: "running" as const,
					name: agentName,
					task: def.task,
					textChunks: [],
					toolCount: 0,
					elapsed: 0,
					sessionFile: makeSessionFile(id),
					turnCount: 1,
					summary: def.summary,
					autoRemove: args.autoRemove,
					model: def.model, // per-agent model override
					maxDurationMs: resolveTimeout(agentName, args.timeout),
					resultBudgetChars: budget.resultChars,
				};
			});

			// Try to create Commander task group for all agents at once
			const client = getCommanderClient();
			if (client && isCommanderAvailable()) {
				const groupName = args.groupName || `subagent-batch-${Date.now()}`;
				const taskTexts = defs.map((def: any) => def.task);
				const payload = buildGroupCreatePayload(
					groupName,
					`Batch subagent group: ${groupName}`,
					taskTexts,
					process.cwd(),
				);
				try {
					const result = await client.callTool("commander_task", payload);
					const parsed = parseGroupCreateResult(result);
					if (parsed && parsed.taskIds.length >= states.length) {
						for (let i = 0; i < states.length; i++) {
							states[i].commanderTaskId = parsed.taskIds[i];
						}
					}
				} catch {
					// Commander group creation failed — proceed without task IDs
				}
			}
			if (commandEpoch !== sessionEpoch) {
				return { content: [{ type: "text", text: "Session changed before the subagent batch could start." }] };
			}

			// Collect peer names for mailbox banter
			const peerNames = states.map(s => `SA-${s.id}-${s.name}`);

			// Register and spawn all agents
			for (const state of states) {
				agents.set(state.id, state);
				registerWidget(state);
			}

			for (const state of states) {
				const peers = peerNames.filter(n => n !== `SA-${state.id}-${state.name}`);
				explicitDispatchHandler("subagent-tool", () => spawnAgent(state, state.task, ctx, peers))();
			}

			const ids = states.map(s => `SA${s.id} (${s.name})`).join(", ");
			return {
				content: [{ type: "text", text: `Batch spawned ${states.length} subagents: ${ids}${deferred > 0 ? `; deferred ${deferred} due to context budget` : ""}` }],
			};
		},
	});

	registerToolWithExecutor(pi, {
		name: "subagent_continue",
		description: "Continue an existing subagent's conversation. Use this to give further instructions to a finished subagent. Returns immediately while it runs in the background.",
		parameters: Type.Object({
			id: Type.Number({ description: "The ID of the subagent to continue" }),
			prompt: Type.String({ description: "The follow-up prompt or new instructions" }),
		}),
		execute: async (callId, args, _signal, _onUpdate, ctx) => {
			widgetCtx = ctx;
			const state = agents.get(args.id);
			if (!state) {
				return { content: [{ type: "text", text: `Error: No SA${args.id} found.` }] };
			}
			if (state.status === "running") {
				return { content: [{ type: "text", text: `Error: SA${args.id} is still running.` }] };
			}

			state.status = "running";
			state.task = args.prompt;
			state.textChunks = [];
			state.elapsed = 0;
			state.turnCount++;

			// Re-register widget if it was removed after the previous turn
			if (!widgetBoxes.has(state.id)) {
				registerWidget(state);
			}
			invalidateWidget(state.id);

			ctx.ui.notify(`Continuing SA${args.id} (${state.name}) Turn ${state.turnCount}…`, "info");
			explicitDispatchHandler("subagent-tool", () => spawnAgent(state, args.prompt, ctx))();

			return {
				content: [{ type: "text", text: `SA${args.id} (${state.name}) continuing conversation in background.` }],
			};
		},
	});

	registerToolWithExecutor(pi, {
		name: "subagent_remove",
		description: "Remove a specific subagent. Kills it if it's currently running.",
		parameters: Type.Object({
			id: Type.Number({ description: "The ID of the subagent to remove" }),
		}),
		execute: async (callId, args, _signal, _onUpdate, ctx) => {
			widgetCtx = ctx;
			const commandEpoch = sessionEpoch;
			const state = agents.get(args.id);
			if (!state) {
				return { content: [{ type: "text", text: `Error: No SA${args.id} found.` }] };
			}

			if (state.proc && state.status === "running") {
				await killGracefully(state.proc);
			}
			if (commandEpoch !== sessionEpoch) {
				return { content: [{ type: "text", text: `Session changed while removing SA${args.id}.` }] };
			}
			clearWidgetCurrent(`sub-${args.id}`);
			widgetBoxes.delete(args.id);
			agents.delete(args.id);

			return {
				content: [{ type: "text", text: `SA${args.id} removed.` }],
			};
		},
	});

	registerToolWithExecutor(pi, {
		name: "subagent_list",
		description: "List all active and finished subagents, showing their IDs, tasks, and status.",
		parameters: Type.Object({}),
		execute: async () => {
			if (agents.size === 0) {
				return { content: [{ type: "text", text: "No active subagents." }] };
			}

			const list = Array.from(agents.values()).map(s =>
				`SA${s.id} [${s.status.toUpperCase()}] ${s.name} - ${s.task}`
			).join("\n");

			return {
				content: [{ type: "text", text: `Subagents:\n${list}` }],
			};
		},
	});

	registerToolWithExecutor(pi, {
		name: "subagent_cleanup",
		description: "Clean up finished and stale subagents. Removes done/error agents and kills agents running longer than max_age_seconds. Use before spawning new batches or when the screen is cluttered.",
		parameters: Type.Object({
			max_age_seconds: Type.Optional(Type.Number({ description: "Kill agents running longer than this (default: 600s = 10 min). Set 0 to only remove done/error agents." })),
		}),
		execute: async (callId, args, _signal, _onUpdate, ctx) => {
			widgetCtx = ctx;
			const maxAge = (args.max_age_seconds ?? 600) * 1000;
			let removedDone = 0;
			let killedStale = 0;
			const killPromises: Promise<void>[] = [];

			for (const [id, state] of Array.from(agents.entries())) {
				if (state.status === "done" || state.status === "error") {
					ctx.ui.setWidget(`sub-${id}`, undefined);
					widgetBoxes.delete(id);
					agents.delete(id);
					removedDone++;
				} else if (state.status === "running" && maxAge > 0 && state.elapsed > maxAge) {
					if (state.proc) {
						killPromises.push(killGracefully(state.proc));
					}
					state.status = "error";
					state.textChunks.push(`\n[CLEANUP] Killed after ${Math.round(state.elapsed / 1000)}s (stale).`);
					ctx.ui.setWidget(`sub-${id}`, undefined);
					widgetBoxes.delete(id);
					agents.delete(id);
					killedStale++;
				}
			}

			await Promise.all(killPromises);
			const remaining = Array.from(agents.values()).filter(a => a.status === "running").length;
			const summary = `Cleanup: removed ${removedDone} done/error, killed ${killedStale} stale. ${remaining} active remain.`;

			return {
				content: [{ type: "text", text: summary }],
			};
		},
	});


	// ── /sub <task> ───────────────────────────────────────────────────────────

	registerHerdrCommands(pi);

	pi.registerCommand("sub", {
		description: "Spawn a subagent with live widget: /sub <task>",
		handler: async (args, ctx) => {
			widgetCtx = ctx;

			const raw = args?.trim();
			if (!raw) {
				ctx.ui.notify("Usage: /sub [NAME] <task>", "error");
				return;
			}

			const parsed = parseSubName(raw);
			if (!parsed.task) {
				ctx.ui.notify("Usage: /sub [NAME] <task>", "error");
				return;
			}

			const id = nextId++;
			const state: SubState = {
				id,
				status: "running",
				name: parsed.name,
				task: parsed.task,
				textChunks: [],
				toolCount: 0,
				elapsed: 0,
				sessionFile: makeSessionFile(id),
				turnCount: 1,
				maxDurationMs: resolveTimeout(parsed.name),
			};
			agents.set(id, state);
			registerWidget(state);

			// Fire-and-forget
			explicitDispatchHandler("subagent-command", () => spawnAgent(state, parsed.task, ctx))();
		},
	});

	// ── /subcont <number> <prompt> ────────────────────────────────────────────

	pi.registerCommand("subcont", {
		description: "Continue an existing subagent's conversation: /subcont <number> <prompt>",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = Array.from(agents.keys()).map((id) => ({ value: String(id), label: String(id) }));
			const filtered = items.filter((item) => item.value.startsWith(prefix.trim()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			widgetCtx = ctx;

			const trimmed = args?.trim() ?? "";
			const spaceIdx = trimmed.indexOf(" ");
			if (spaceIdx === -1) {
				ctx.ui.notify("Usage: /subcont <number> <prompt>", "error");
				return;
			}

			const num = parseInt(trimmed.slice(0, spaceIdx), 10);
			const prompt = trimmed.slice(spaceIdx + 1).trim();

			if (isNaN(num) || !prompt) {
				ctx.ui.notify("Usage: /subcont <number> <prompt>", "error");
				return;
			}

			const state = agents.get(num);
			if (!state) {
				ctx.ui.notify(`No SA${num} found. Use /sub to create one.`, "error");
				return;
			}

			if (state.status === "running") {
				ctx.ui.notify(`SA${num} is still running — wait for it to finish first.`, "warning");
				return;
			}

			// Resume: update state for a new turn
			state.status = "running";
			state.task = prompt;
			state.textChunks = [];
			state.elapsed = 0;
			state.turnCount++;

			// Re-register widget if it was removed (e.g. after auto-remove)
			if (!widgetBoxes.has(state.id)) {
				registerWidget(state);
			}
			invalidateWidget(state.id);

			ctx.ui.notify(`Continuing SA${num} (${state.name}) Turn ${state.turnCount}…`, "info");

			// Fire-and-forget — reuses the same sessionFile for conversation history
			explicitDispatchHandler("subagent-command", () => spawnAgent(state, prompt, ctx))();
		},
	});

	// ── /subrm <number> ───────────────────────────────────────────────────────

	pi.registerCommand("subrm", {
		description: "Remove a specific subagent widget: /subrm <number>",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = Array.from(agents.keys()).map((id) => ({ value: String(id), label: String(id) }));
			const filtered = items.filter((item) => item.value.startsWith(prefix.trim()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			widgetCtx = ctx;
			const commandEpoch = sessionEpoch;

			const num = parseInt(args?.trim() ?? "", 10);
			if (isNaN(num)) {
				ctx.ui.notify("Usage: /subrm <number>", "error");
				return;
			}

			const state = agents.get(num);
			if (!state) {
				ctx.ui.notify(`No SA${num} found.`, "error");
				return;
			}

			// Kill the process if still running
			const wasRunning = state.proc && state.status === "running";
			if (wasRunning) await killGracefully(state.proc);
			if (commandEpoch !== sessionEpoch) return;
			notifyCurrent(`SA${num} ${wasRunning ? "killed and removed" : "removed"}.`, wasRunning ? "warning" : "info");

			clearWidgetCurrent(`sub-${num}`);
			widgetBoxes.delete(num);
			agents.delete(num);
		},
	});

	// ── /subclear ─────────────────────────────────────────────────────────────

	pi.registerCommand("subclear", {
		description: "Clear all subagent widgets",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;
			const commandEpoch = sessionEpoch;

			let killed = 0;
			const killPromises: Promise<void>[] = [];
			for (const [id, state] of Array.from(agents.entries())) {
				if (state.proc && state.status === "running") {
					killPromises.push(killGracefully(state.proc));
					killed++;
				}
				clearWidgetCurrent(`sub-${id}`);
			}
			await Promise.all(killPromises);
			if (commandEpoch !== sessionEpoch) return;

			const total = agents.size;
			agents.clear();
			widgetBoxes.clear();
			nextId = 1;

			const msg = total === 0
				? "No subagents to clear."
				: `Cleared ${total} subagent${total !== 1 ? "s" : ""}${killed > 0 ? ` (${killed} killed)` : ""}.`;
			notifyCurrent(msg, total === 0 ? "info" : "success");
		},
	});

	// ── Session lifecycle ─────────────────────────────────────────────────────

	// Invalidate background callbacks before the runtime replaces this context.
	// This handler also runs during extension reload, where the old closure can
	// otherwise receive a late child-process event.
	pi.on("session_shutdown", async (_event, ctx) => withSessionLifecycle(async () => {
		sessionEpoch++;
		widgetCtx = undefined;
		const killPromises: Promise<void>[] = [];
		for (const [id, state] of Array.from(agents.entries())) {
			if (state.elapsedTimer) {
				clearInterval(state.elapsedTimer);
				state.elapsedTimer = undefined;
			}
			if (state.watchdogTimer) {
				clearTimeout(state.watchdogTimer);
				state.watchdogTimer = undefined;
			}
			if (state.proc && state.status === "running") {
				killPromises.push(killGracefully(state.proc));
			}
			try { ctx?.ui?.setWidget?.(`sub-${id}`, undefined); } catch {}
		}
		await Promise.all(killPromises);
		agents.clear();
		widgetBoxes.clear();
	}));

	// Startup only restores local state and registers controls. It must not
	// dispatch a warmup/scout child before the user asks for one.
	pi.on("session_start", async (_event, ctx) => withSessionLifecycle(async () => {
		sessionEpoch++;
		const startEpoch = sessionEpoch;
		widgetCtx = ctx;
		const startCwd = contextCwd(ctx);
		applyExtensionDefaults(import.meta.url, ctx);
		const sessDir = path.join(os.homedir(), ".pi", "agent", "sessions", "subagents");
		cleanOldSessionFiles(sessDir, 7);
		pruneRunArtifacts(path.join(startCwd, ".pi", "agent-sessions")); // 7-day retention
		reconcileJournal(path.join(startCwd, ".pi", "agent-sessions"));
		const killPromises: Promise<void>[] = [];
		for (const [id, state] of Array.from(agents.entries())) {
			if (state.elapsedTimer) {
				clearInterval(state.elapsedTimer);
				state.elapsedTimer = undefined;
			}
			if (state.proc && state.status === "running") {
				killPromises.push(killGracefully(state.proc));
			}
			ctx.ui.setWidget(`sub-${id}`, undefined);
		}
		await Promise.all(killPromises);
		if (startEpoch !== sessionEpoch) return;
		agents.clear();
		widgetBoxes.clear();
		nextId = 1;

		// Clear stale scout state from previous session

		// Load model config from .pi/agents/models.json, then scan agent .md files.
		// Models come from the JSON config; .md files provide tools + system prompts.
		const extDir = path.dirname(fileURLToPath(import.meta.url));
		const extProjectDir = path.resolve(extDir, "..");
		modelsConfig = loadAgentModelsConfig(startCwd, extProjectDir);
		const standardAgents = scanAgentDefs(startCwd, extProjectDir, modelsConfig);
		const toolkitModelsConfig = loadToolkitModelsConfig(startCwd, extProjectDir);
		const toolkitAgents = scanToolkitAgentDefs(startCwd, extProjectDir, toolkitModelsConfig);
		knownAgents = new Map([...standardAgents, ...toolkitAgents]);

		// ── Expose global hooks for escape-cancel integration ────────────
		(globalThis as any).__piKillAllSubagents = (): number => {
			let killed = 0;
			for (const [, state] of agents) {
				if (state.proc && state.status === "running") {
					try { state.proc.kill("SIGTERM"); } catch {}
					killed++;
				}
			}
			return killed;
		};
		(globalThis as any).__piHasRunningSubagents = (): boolean => {
			for (const [, state] of agents) {
				if (state.status === "running") return true;
			}
			return false;
		};
	}));

	// ── /new resets widgets; it must not start a child ──────────────────────

	pi.on("session_switch", async (_event, ctx) => withSessionLifecycle(async () => {
		// Bind the replacement context and invalidate old callbacks before awaits.
		sessionEpoch++;
		const switchEpoch = sessionEpoch;
		widgetCtx = ctx;
		// Kill running subagents and clear all widgets
		const killPromises: Promise<void>[] = [];
		for (const [id, state] of Array.from(agents.entries())) {
			if (state.elapsedTimer) {
				clearInterval(state.elapsedTimer);
				state.elapsedTimer = undefined;
			}
			if (state.proc && state.status === "running") {
				killPromises.push(killGracefully(state.proc));
			}
			ctx.ui.setWidget(`sub-${id}`, undefined);
		}
		await Promise.all(killPromises);
		if (switchEpoch !== sessionEpoch) return;
		agents.clear();
		widgetBoxes.clear();
		nextId = 1;
	}));
}
