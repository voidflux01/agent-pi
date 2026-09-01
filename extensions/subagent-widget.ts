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
import { scanAgentDefs, scanToolkitAgentDefs, resolveAgentByName, loadAgentModelsConfig, loadToolkitModelsConfig, resolveAgentModelString, type AgentDef, type AgentModelsConfig } from "./lib/agent-defs.ts";
import { resolveToolkitWorkerModel, isToolkitCliAgent, parseToolkitResult, toolkitRuntimeName, runToolkitDispatch } from "./lib/toolkit-cli.ts";
import { buildMailboxPreamble, mailboxPreambleEnabled } from "./lib/fleet-mailbox.ts";
import { currentDispatchAuthorization, isExplicitDispatchActive, run as runDispatch, explicitDispatchHandler, withSessionLifecycle, type DispatchFailure } from "./lib/dispatch-runtime.ts";
import { buildAgentResultContractPrompt, checkResultCompliance, composeAgentResult, contractGateEnabled, persistFullOutput, runBaseName } from "./lib/agent-result-contract.ts";
import { journalAppend, journalList, journalUpdate, pruneRunArtifacts, reconcileJournal, type TaskJournalEntry } from "./lib/agent-task-journal.ts";
import { readLastAssistantText, sessionUsage, countSessionToolCalls, updateHerdrPaneStatus, registerHerdrCommands, herdrWorkerLabel } from "./lib/herdr-client.ts";
import { shouldAwaitSubagentResult } from "./lib/task-gate.ts";
import { applyWorkerLaunchPolicy, implementationWorkerPrompt, isExecutionWorker } from "./lib/worker-budget.ts";
import { discoverResearchTools } from "./lib/research-protocol.ts";
import { createWorkerLifecycle } from "./lib/worker-lifecycle.ts";
import { createOrchestrationRun, DEFAULT_ORCHESTRATION_TIMEOUT_MS, type OrchestrationRun } from "./lib/orchestration-run.ts";
import { coordinationState } from "./lib/coordination-state.ts";
import { withSessionResume } from "./lib/subagent-recovery.ts";
import { listOrchestrationRuns, readOrchestrationEvents } from "./lib/orchestration-query.ts";

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

/** UI cleanup is best-effort and must not keep a headless parent alive. */
function scheduleUnrefCleanup(callback: () => void, delayMs: number): void {
	const timer = setTimeout(callback, delayMs);
	try { (timer as any).unref?.(); } catch {}
}

/** Grace period after SIGTERM before escalating to SIGKILL. */
const TIMEOUT_KILL_GRACE_MS = 30_000;
export const DEFAULT_SUBAGENT_TIMEOUT_MS = DEFAULT_ORCHESTRATION_TIMEOUT_MS;

/** Use the shared RunContext deadline by default; explicit zero disables it. */
export function resolveTimeout(_name: string, explicitTimeout?: number): number {
	if (explicitTimeout !== undefined && explicitTimeout >= 0) return explicitTimeout;
	return DEFAULT_SUBAGENT_TIMEOUT_MS;
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
	autoRemove?: boolean;      // auto-remove widget ~30s after done (default: true)
	model?: string;            // resolved model string for display
	saRunId?: string;      // task-journal row id for this dispatch (= output file base)
	maxDurationMs: number;     // watchdog timeout — kills agent after this duration
	resultBudgetChars?: number; // parent-visible result budget, scaled by context usage
	result?: string;         // bounded result retained for an explicit wait/join
	completion?: Promise<string>;
	retainUntilCollected?: boolean;
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
	const lifecycle = createWorkerLifecycle();

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

	function resumableJournalEntry(cwd: string, id: string): TaskJournalEntry | undefined {
		const entry = journalList(path.join(cwd, ".pi", "agent-sessions")).find(candidate => candidate.kind === "sa" && candidate.id === id);
		if (!entry?.sessionFile || isToolkitCliAgent(entry.agent)) return undefined;
		const root = path.resolve(os.homedir(), ".pi", "agent", "sessions", "subagents") + path.sep;
		const sessionFile = path.resolve(entry.sessionFile);
		if (!sessionFile.startsWith(root)) return undefined;
		try {
			const stat = fs.lstatSync(sessionFile);
			if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
		} catch { return undefined; }
		return entry;
	}

	/**
	 * Recoverable view of a persisted batch. This is deliberately read-only:
	 * after a restart the volatile SA ids are gone, so the caller must inspect
	 * the candidates and explicitly resume only the workers it still wants.
	 */
	function inspectPersistedBatch(cwd: string, runId: string): {
		runId: string;
		status: string;
		mode?: string;
		children: Array<{ dispatchId: string; status: string; canResume: boolean; sessionFile?: string }>;
	} | undefined {
		const run = listOrchestrationRuns(cwd, { runId, limit: 1 })[0];
		if (!run || run.actor !== "subagent_batch") return undefined;
		const started = new Map<string, string>();
		const completed = new Map<string, string>();
		for (const event of readOrchestrationEvents(run.eventDir, 200)) {
			const raw = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
			const data = raw.data && typeof raw.data === "object" ? raw.data as Record<string, unknown> : raw;
			if (typeof data.dispatchId !== "string" || !/^[A-Za-z0-9_.-]{1,160}$/.test(data.dispatchId)) continue;
			if (event.type === "subagent.started") started.set(data.dispatchId, "running");
			if (event.type === "subagent.completed") completed.set(data.dispatchId, typeof data.status === "string" ? data.status : "done");
		}
		const entries = new Map(journalList(path.join(cwd, ".pi", "agent-sessions")).map((entry) => [entry.id, entry]));
		const children = [...started.keys()].map((dispatchId) => {
			const entry = entries.get(dispatchId);
			const status = completed.get(dispatchId) || entry?.status || "unknown";
			return {
				dispatchId,
				status,
				canResume: !completed.has(dispatchId) && !!resumableJournalEntry(cwd, dispatchId),
				...(entry?.sessionFile ? { sessionFile: entry.sessionFile } : {}),
			};
		});
		return { runId: run.runId, status: run.status, ...(run.mode ? { mode: run.mode } : {}), children };
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
		options: { orchestrationRun?: OrchestrationRun; onSettled?: (status: "succeeded" | "failed" | "cancelled") => void; signal?: AbortSignal } = {},
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
			mode: coordinationState().mode,
			runtime: toolkitRuntimeName(state.name),
			task: prompt,
			model: isToolkitCliAgent(state.name) ? undefined : (state.model || undefined),
			sessionFile: isToolkitCliAgent(state.name) ? undefined : state.sessionFile,
			status: "dispatched",
			resumed: fs.existsSync(state.sessionFile),
			startedAt: Date.now(),
			updatedAt: Date.now(),
		});
		const ownsOrchestrationRun = !options.orchestrationRun;
		const orchestrationRun = options.orchestrationRun ?? createOrchestrationRun({
			context: ctx,
			actor: `subagent:${state.name.toLowerCase()}`,
			mode: coordinationState().mode,
			budget: { maxSteps: 1, maxDurationMs: state.maxDurationMs > 0 ? state.maxDurationMs : 15 * 60_000 },
			workspaceCwd: spawnCwd,
		});
		if (state.saRunId) journalUpdate(saDir, state.saRunId, { orchestrationRunId: orchestrationRun.runId });
		orchestrationRun.consumeStep();
		orchestrationRun.record("subagent.started", { agent: state.name, dispatchId: state.saRunId });
		const settleOrchestration = (status: "succeeded" | "failed" | "cancelled", payload: Record<string, unknown>) => {
			if (payload.usage && typeof payload.usage === "object") {
				orchestrationRun.recordUsage(payload.usage as { totalTokens?: number; costUsd?: number });
			}
			orchestrationRun.record("subagent.completed", payload);
			if (ownsOrchestrationRun) {
				orchestrationRun.finish(status, { agent: state.name, exitCode: payload.exitCode });
			} else {
				options.onSettled?.(status);
			}
		};

		const extDir = path.dirname(fileURLToPath(import.meta.url));

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

		// Build one stable prompt block instead of several append flags. This keeps
		// the worker's system-prefix reusable for provider prompt caching.
		const promptParts: string[] = [];
		if (agentDef?.systemPrompt) promptParts.push(agentDef.systemPrompt);
		if (!isToolkitCliAgent(state.name)) {
			promptParts.push(buildAgentResultContractPrompt());
			if (isExecutionWorker(state.name)) promptParts.push(implementationWorkerPrompt());
		}
		const systemPromptArgs = ["--append-system-prompt", promptParts.join("\n\n")];

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
		return new Promise<string>((resolve) => {
			const startTime = Date.now();
			const timer = lifecycle.trackTimer(setInterval(() => {
				if (spawnEpoch !== sessionEpoch) {
					lifecycle.clearTimer(timer);
					return;
				}
				state.elapsed = Date.now() - startTime;
				if (state.sessionFile) {
					const n = countSessionToolCalls(state.sessionFile);
					if (n > state.toolCount) state.toolCount = n;
				}
				invalidateWidget(state.id);
			}, 1000));
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
				lifecycle.clearTimer(timer);
				if (state.elapsedTimer === timer) state.elapsedTimer = undefined;
				// Clear watchdog — agent exited normally before timeout
				if (state.watchdogTimer) {
					clearTimeout(state.watchdogTimer);
					state.watchdogTimer = undefined;
				}
				// The child belongs to the replaced session. Finish timer cleanup,
				// then stop before mutating its state or touching any session-bound UI.
				if (spawnEpoch !== sessionEpoch) {
					settleOrchestration("cancelled", { agent: state.name, exitCode: code ?? 130, cancelled: true });
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
				lifecycle.clearProcess(state.proc);
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

				const result = externalFull ?? state.textChunks.join("");
				let measuredUsage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; costUsd: number } | undefined;
				try {
					const usage = externalUsage ?? sessionUsage(state.sessionFile);
					if (usage.totalTokens > 0) measuredUsage = {
						input: usage.input,
						output: usage.output,
						cacheRead: usage.cacheRead,
						cacheWrite: usage.cacheWrite,
						totalTokens: usage.totalTokens,
						costUsd: Math.round(usage.costUsd * 1e6) / 1e6,
					};
				} catch {}

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
				settleOrchestration(code === 0 && !failure ? "succeeded" : code === 130 ? "cancelled" : "failed", {
					agent: state.name,
					exitCode: code,
					failure,
					outputFile: fullOutputPath || undefined,
					usage: measuredUsage,
				});
				const toolkitRun = isToolkitCliAgent(state.name);
				let contractProblems: string[] = [];
				if (!toolkitRun) {
					try {
						const compliance = checkResultCompliance(result);
						contractProblems = compliance.ok ? [] : compliance.problems;
					} catch {}
				}
				try {
					journalUpdate(saOutDir, state.saRunId ?? "", {
						status: code === 0 && !failure ? "done" : "error",
						exitCode: code,
						elapsedMs: state.elapsed,
						model: state.model || undefined,
						outputFile: fullOutputPath || undefined,
						note: [failure ? `dispatch: ${failure}` : "", contractProblems.length > 0 ? `result contract: ${contractProblems.join("; ")}` : ""].filter(Boolean).join("; ") || undefined,
						usage: measuredUsage,
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
				state.result = compactResult.content;
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
				if (!state.retainUntilCollected && shouldScheduleWidgetRemoval(state, false)) {
					scheduleUnrefCleanup(() => {
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
			const argv = withSessionResume([
				"--mode", "json",
				"-p",
				"--session", state.sessionFile,
				"--model", model,
				"--tools", tools,
				...systemPromptArgs,
				prompt,
			], state.sessionFile);

			if (isToolkitCliAgent(state.name)) {
				const extTask0 = mailboxPreambleEnabled() ? `${buildMailboxPreamble(mailboxAgent, spawnCwd)}\n\n---\n\n${prompt}` : prompt;
				void runToolkitDispatch({
					agentName: state.name,
					task: extTask0,
					cwd: spawnCwd,
					env: spawnEnv,
					sessionDir: saDir,
					runId: state.saRunId ?? `sa${state.id}`,
					parentRunId: orchestrationRun.runId,
					mode: coordinationState().mode,
					timeoutMs: state.maxDurationMs,
					journal: { dir: saDir, id: state.saRunId ?? "" },
					paneTitle,
					onProcess: (proc: any) => {
						if (spawnEpoch === sessionEpoch) state.proc = lifecycle.trackProcess(proc);
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
				isCancelled: () => spawnEpoch !== sessionEpoch || !!options.signal?.aborted,
				}).then(({ exitCode, raw }) => {
					const parsed = parseToolkitResult(state.name, raw);
					if (parsed.model) state.model = parsed.model;
					finish(exitCode, parsed.text || raw || undefined, parsed.usage);
				}).catch(() => finish(1));
				return;
			}

			// Standard Pi transport is shared with team, chain, and pipeline. The
			// Keep watchdog, epoch, and follow-up policies local to this widget.
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
				parentRunId: orchestrationRun.runId,
				mode: coordinationState().mode,
				isAborted: () => spawnEpoch !== sessionEpoch || !!options.signal?.aborted,
				onProcess: (child) => {
					if (spawnEpoch === sessionEpoch) state.proc = lifecycle.trackProcess(child as any);
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
		name: "subagent_batch_recover",
		label: "Recover Subagent Batch",
		description: "Inspect a persisted subagent batch after restart and return unfinished dispatch ids that are safe to resume. Read-only: it never re-dispatches workers automatically; use subagent_resume explicitly for selected candidates.",
		parameters: Type.Object({
			run_id: Type.String({ description: "Persisted parent run id returned by subagent_create_batch" }),
		}),
		capabilityRisk: "read",
		capabilityEffect: { ordering: "commutative" },
		execute: async (_callId, args, _signal, _onUpdate, ctx) => {
			const recovery = inspectPersistedBatch(contextCwd(ctx), args.run_id);
			if (!recovery) {
				return { content: [{ type: "text", text: `No persisted subagent batch found for ${args.run_id}.` }], details: { found: false, runId: args.run_id } };
			}
			const resumable = recovery.children.filter((child) => child.canResume).map((child) => child.dispatchId);
			const text = [
				`Batch ${recovery.runId} status=${recovery.status}${recovery.mode ? ` mode=${recovery.mode}` : ""}`,
				...recovery.children.map((child) => `${child.status.padEnd(9)} ${child.dispatchId}${child.canResume ? " resumable" : ""}`),
				resumable.length > 0 ? `Resume candidates: ${resumable.join(", ")}. Call subagent_resume with an explicit prompt for each selected worker.` : "No unfinished worker has a safe persisted session to resume.",
			].join("\n");
			return { content: [{ type: "text", text }], details: { found: true, ...recovery, resumableDispatchIds: resumable } };
		},
	});

	registerToolWithExecutor(pi, {
		name: "subagent_create",
		description: "Spawn a subagent to perform a task. When `name` is scout, this call blocks until that scout finishes and returns its RESULT — treat that ## RESULT as the report, do not read the archived transcript unless a path is missing, and do not start overlapping reconnaissance in the same turn. Toolkit CLIs (omp-agent, prime-agent, and other named harnesses) also block until the CLI exits; do not poll with subagent_list or sleep. Other roles return the subagent ID immediately and deliver results as a follow-up message when finished.\n\nWhen `name` matches a known agent definition (scout, builder, reviewer, planner, tester, red-team, omp-agent, prime-agent), that agent's configured model, tools, and system prompt are automatically applied. Only set `model` to override the agent's default.",
		parameters: Type.Object({
			task: Type.String({ description: "The complete task description for the subagent to perform" }),
			name: Type.Optional(Type.String({ description: "Short role label (e.g. REVIEWER, SCOUT). If this matches a known agent definition, that agent's model/tools/prompt are auto-applied." })),
			summary: Type.Optional(Type.String({ description: "Short summary shown in widget (no markdown)" })),
			model: Type.Optional(Type.String({ description: "Model override. Only set this to override the agent's default model. If omitted, uses the agent definition's model or the system default." })),
			autoRemove: Type.Optional(Type.Boolean({ description: "Auto-remove widget ~30s after done (default: true)" })),
			timeout: Type.Optional(Type.Number({ description: "Optional max runtime in milliseconds. Omit for the 15-minute safety deadline; use 0 only to disable the watchdog." })),
		}),
		execute: async (callId, args, signal, _onUpdate, ctx) => {
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
				autoRemove: args.autoRemove,
				model: args.model, // caller-specified model override
				maxDurationMs: resolveTimeout(agentName, args.timeout),
				awaitResult,
			};
			agents.set(id, state);
			registerWidget(state);

			const started = explicitDispatchHandler("subagent-tool", () => spawnAgent(state, args.task, ctx, { signal: awaitResult ? signal : undefined }))();
			state.completion = started;
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
		description: "Spawn multiple subagents at once. By default the tool returns immediately; call subagent_wait with the returned SA IDs to join their bounded results. Set join: true to spawn and perform one bounded join in this same call, reducing a model round trip. When an agent's `name` matches a known agent definition, that agent's configured model, tools, and system prompt are automatically applied.",
		parameters: Type.Object({
			agents: Type.Array(Type.Object({
				task: Type.String({ description: "The complete task description for the subagent" }),
				name: Type.Optional(Type.String({ description: "Short role label (e.g. REVIEWER, SCOUT). If this matches a known agent definition, that agent's model/tools/prompt are auto-applied." })),
				summary: Type.Optional(Type.String({ description: "Short summary shown in widget (no markdown)" })),
				model: Type.Optional(Type.String({ description: "Model override. Only set to override the agent definition's default model." })),
			}), { description: "Array of agent definitions to spawn" }),
			autoRemove: Type.Optional(Type.Boolean({ description: "Auto-remove widgets ~30s after done (default: true)" })),
			timeout: Type.Optional(Type.Number({ description: "Optional max runtime in ms for every agent in this batch. Omit for the 15-minute safety deadline; use 0 only to disable the watchdog." })),
			force: Type.Optional(Type.Boolean({ description: "Force spawn even if agents are already running (default: false)" })),
			join: Type.Optional(Type.Boolean({ description: "Wait for all spawned agents and return bounded summaries in this call (default: false)" })),
		}),
		execute: async (callId, args, signal, _onUpdate, ctx) => {
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
					awaitResult: true,
					retainUntilCollected: true,
				};
			});

			if (commandEpoch !== sessionEpoch) {
				return { content: [{ type: "text", text: "Session changed before the subagent batch could start." }] };
			}

			const batchRun = createOrchestrationRun({
				context: ctx,
				actor: "subagent_batch",
				mode: coordinationState().mode,
				budget: { maxSteps: states.length, maxDurationMs: args.timeout && args.timeout > 0 ? args.timeout : 15 * 60_000 },
				workspaceCwd: contextCwd(ctx),
			});
			let batchRemaining = states.length;
			let batchFailed = false;
			let batchCancelled = false;
			const onBatchSettled = (status: "succeeded" | "failed" | "cancelled") => {
				batchCancelled ||= status === "cancelled";
				batchFailed ||= status === "failed";
				batchRemaining -= 1;
				if (batchRemaining === 0) {
					batchRun.finish(batchCancelled ? "cancelled" : batchFailed ? "failed" : "succeeded", {
						total: states.length,
						failed: states.filter((state) => state.status === "error").length,
					});
				}
			};

			// Register and spawn all agents
			for (const state of states) {
				agents.set(state.id, state);
				registerWidget(state);
			}

			for (const state of states) {
				state.completion = explicitDispatchHandler("subagent-tool", () => spawnAgent(state, state.task, ctx, {
					orchestrationRun: batchRun,
					onSettled: onBatchSettled,
				}))();
			}

			const ids = states.map(s => `SA${s.id} (${s.name})`).join(", ");
			if (args.join === true) {
				const timeoutMs = args.timeout && args.timeout > 0 ? args.timeout : 0;
				const allResults = Promise.all(states.map((state) => state.completion || Promise.resolve(`${state.name} is running without a join handle.`)));
				let timer: ReturnType<typeof setTimeout> | undefined;
				let abortHandler: (() => void) | undefined;
				type JoinOutcome = { kind: "joined"; value: string[] } | { kind: "timedOut" } | { kind: "aborted" };
				const waitPromises: Promise<JoinOutcome>[] = [allResults.then((value) => ({ kind: "joined" as const, value }))];
				if (timeoutMs > 0) waitPromises.push(new Promise<JoinOutcome>((resolve) => { timer = setTimeout(() => resolve({ kind: "timedOut" }), timeoutMs); }));
				if (signal) {
					if (signal.aborted) return { content: [{ type: "text", text: "Batch join cancelled; background subagents remain running." }], details: { joined: false, aborted: true, ids: states.map((state) => state.id), runId: batchRun.runId } };
					waitPromises.push(new Promise<JoinOutcome>((resolve) => {
						abortHandler = () => resolve({ kind: "aborted" });
						signal.addEventListener("abort", abortHandler, { once: true });
					}));
				}
				const outcome = await Promise.race(waitPromises);
				if (timer) clearTimeout(timer);
				if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
				if (outcome.kind !== "joined") {
					return {
						content: [{ type: "text", text: outcome.kind === "timedOut" ? `Batch join timed out after ${timeoutMs}ms.` : "Batch join cancelled; background subagents remain running." }],
						details: { joined: false, ...(outcome.kind === "timedOut" ? { timedOut: true, timeoutMs } : { aborted: true }), ids: states.map((state) => state.id), statuses: states.map((state) => state.status), runId: batchRun.runId },
					};
				}
				for (const state of states) {
					state.retainUntilCollected = false;
					if (state.status !== "running") scheduleUnrefCleanup(() => { if (agents.get(state.id) === state && state.status !== "running") { clearWidgetCurrent(`sub-${state.id}`); widgetBoxes.delete(state.id); agents.delete(state.id); } }, 30_000);
				}
				const joined = outcome.value.map((result, index) => `SA${states[index].id} ${states[index].name}:\n${result}`).join("\n\n");
				return {
					content: [{ type: "text", text: joined.length > 12000 ? joined.slice(0, 11970) + "\n... [join truncated]" : joined }],
					details: { joined: true, timedOut: false, ids: states.map((state) => state.id), statuses: states.map((state) => state.status), runId: batchRun.runId },
				};
			}
			return {
				content: [{ type: "text", text: `Batch spawned ${states.length} subagents: ${ids}${deferred > 0 ? `; deferred ${deferred} due to context budget` : ""}` }],
				details: { runId: batchRun.runId, ids: states.map((state) => state.id), count: states.length, deferred },
			};
		},
	});

	registerToolWithExecutor(pi, {
		name: "subagent_wait",
		label: "Wait for Subagents",
		description: "Wait for selected background subagents and return bounded results. Use after subagent_create_batch to join parallel work without replaying full transcripts into the parent context.",
		capabilityRisk: "read",
		capabilityEffect: { ordering: "commutative" },
		parameters: Type.Object({
			ids: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 16, description: "Subagent IDs to join. Omit to join all currently tracked subagents." })),
			timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 900000, description: "Maximum wait in milliseconds. 0 means wait until all selected agents finish." })),
		}),
		execute: async (_callId, args, signal) => {
			const requested: number[] = Array.isArray(args.ids) ? args.ids : Array.from(agents.keys());
			const missing = requested.filter((id) => !agents.has(id));
			if (missing.length > 0) {
				return { content: [{ type: "text", text: `Unknown subagent id(s): ${missing.join(", ")}. Use subagent_list to inspect tracked agents.` }] };
			}
			const selected = requested.map((id) => agents.get(id)!).filter(Boolean);
			if (selected.length === 0) return { content: [{ type: "text", text: "No subagents to wait for." }] };
			const waitFor = async (state: SubState): Promise<string> => {
				if (state.status !== "running") return state.result || `${state.name} finished with no result.`;
				if (!state.completion) return `${state.name} is running without a join handle.`;
				return state.completion;
			};
			const allResults = Promise.all(selected.map(waitFor));
			const timeoutMs = args.timeout_ms && args.timeout_ms > 0 ? args.timeout_ms : 0;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let abortHandler: (() => void) | undefined;
			type WaitOutcome = { kind: "joined"; value: string[] } | { kind: "timedOut" } | { kind: "aborted" };
			const waitPromises: Promise<WaitOutcome>[] = [allResults.then((value) => ({ kind: "joined" as const, value }))];
			if (timeoutMs > 0) waitPromises.push(new Promise<WaitOutcome>((resolve) => { timer = setTimeout(() => resolve({ kind: "timedOut" }), timeoutMs); }));
			if (signal) {
				if (signal.aborted) return { content: [{ type: "text", text: "Wait cancelled; background subagents remain running." }], details: { joined: false, aborted: true, ids: selected.map((state) => state.id), statuses: selected.map((state) => state.status) } };
				waitPromises.push(new Promise<WaitOutcome>((resolve) => {
					abortHandler = () => resolve({ kind: "aborted" });
					signal.addEventListener("abort", abortHandler, { once: true });
				}));
			}
			const results = await Promise.race(waitPromises);
			if (timer) clearTimeout(timer);
			if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
			if (results.kind === "timedOut") {
				return {
					content: [{ type: "text", text: `Wait timed out after ${timeoutMs}ms. Running: ${selected.filter((state) => state.status === "running").map((state) => `SA${state.id}`).join(", ") || "none"}.` }],
					details: { joined: false, timedOut: true, timeoutMs, ids: selected.map((state) => state.id), statuses: selected.map((state) => state.status) },
				};
			}
			if (results.kind === "aborted") {
				return {
					content: [{ type: "text", text: "Wait cancelled; background subagents remain running." }],
					details: { joined: false, aborted: true, timedOut: false, ids: selected.map((state) => state.id), statuses: selected.map((state) => state.status) },
				};
			}
			for (const state of selected) {
				if (!state.retainUntilCollected) continue;
				state.retainUntilCollected = false;
				if (state.status !== "running") {
					scheduleUnrefCleanup(() => {
						if (agents.get(state.id) !== state || state.status === "running") return;
						clearWidgetCurrent(`sub-${state.id}`);
						widgetBoxes.delete(state.id);
						agents.delete(state.id);
					}, 30_000);
				}
			}
			const joined = results.value.map((result, index) => `SA${selected[index].id} ${selected[index].name}:\n${result}`).join("\n\n");
			return {
				content: [{ type: "text", text: joined.length > 12000 ? joined.slice(0, 11970) + "\n... [join truncated]" : joined }],
				details: { joined: true, timedOut: false, ids: selected.map((state) => state.id), statuses: selected.map((state) => state.status) },
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
		name: "subagent_resume",
		description: "Resume a persisted subagent after a parent restart. Use the journal dispatch id shown by /agents-status, not the volatile SA number.",
		parameters: Type.Object({
			run_id: Type.String({ description: "Persisted task-journal dispatch id, for example builder-sa2-..." }),
			prompt: Type.String({ description: "The follow-up prompt or recovery instruction" }),
		}),
		execute: async (_callId, args, _signal, _onUpdate, ctx) => {
			widgetCtx = ctx;
			const entry = resumableJournalEntry(contextCwd(ctx), args.run_id);
			if (!entry) return { content: [{ type: "text", text: `No safe resumable subagent dispatch found for ${args.run_id}.` }] };
			const id = nextId++;
			const state: SubState = {
				id,
				status: "running",
				name: displayAgentName(entry.agent),
				task: args.prompt,
				textChunks: [],
				toolCount: 0,
				elapsed: 0,
				sessionFile: entry.sessionFile!,
				turnCount: 2,
				model: entry.model,
				maxDurationMs: resolveTimeout(entry.agent),
			};
			agents.set(id, state);
			registerWidget(state);
			const result = await explicitDispatchHandler("subagent-resume", () => spawnAgent(state, args.prompt, ctx, { signal }))();
			return { content: [{ type: "text", text: result || `SA${id} resumed from ${args.run_id}.` }] };
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

	pi.registerCommand("subresume", {
		description: "Resume a persisted subagent: /subresume <journal-id> <prompt>",
		handler: async (args, ctx) => {
			widgetCtx = ctx;
			const trimmed = args?.trim() ?? "";
			const spaceIdx = trimmed.indexOf(" ");
			if (spaceIdx === -1) {
				ctx.ui.notify("Usage: /subresume <journal-id> <prompt>", "error");
				return;
			}
			const runId = trimmed.slice(0, spaceIdx);
			const prompt = trimmed.slice(spaceIdx + 1).trim();
			const entry = resumableJournalEntry(contextCwd(ctx), runId);
			if (!entry || !prompt) {
				ctx.ui.notify(`No safe resumable subagent dispatch found for ${runId}.`, "error");
				return;
			}
			const id = nextId++;
			const state: SubState = {
				id,
				status: "running",
				name: displayAgentName(entry.agent),
				task: prompt,
				textChunks: [],
				toolCount: 0,
				elapsed: 0,
				sessionFile: entry.sessionFile!,
				turnCount: 2,
				model: entry.model,
				maxDurationMs: resolveTimeout(entry.agent),
			};
			agents.set(id, state);
			registerWidget(state);
			ctx.ui.notify(`Resuming ${entry.agent} from ${runId} as SA${id}…`, "info");
			explicitDispatchHandler("subagent-command-resume", () => spawnAgent(state, prompt, ctx))();
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
		lifecycle.stopAll();
		sessionEpoch++;
		widgetCtx = undefined;
		const killPromises: Promise<void>[] = [];
		for (const [id, state] of Array.from(agents.entries())) {
			if (state.elapsedTimer) {
				lifecycle.clearTimer(state.elapsedTimer);
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
				lifecycle.clearTimer(state.elapsedTimer);
				state.elapsedTimer = undefined;
			}
			if (state.watchdogTimer) {
				clearTimeout(state.watchdogTimer);
				state.watchdogTimer = undefined;
			}
			if (state.proc && state.status === "running") {
				const proc = state.proc;
				lifecycle.clearProcess(proc);
				killPromises.push(killGracefully(proc));
			}
			else if (state.proc) {
				lifecycle.clearProcess(state.proc);
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
				lifecycle.clearTimer(state.elapsedTimer);
				state.elapsedTimer = undefined;
			}
			if (state.watchdogTimer) {
				clearTimeout(state.watchdogTimer);
				state.watchdogTimer = undefined;
			}
			if (state.proc && state.status === "running") {
				const proc = state.proc;
				lifecycle.clearProcess(proc);
				killPromises.push(killGracefully(proc));
			}
			else if (state.proc) {
				lifecycle.clearProcess(state.proc);
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
