// ABOUTME: Multi-agent team dispatcher with specialist agents and grid dashboard.
// ABOUTME: Primary agent delegates via dispatch_agent tool; teams defined in .pi/agents/teams.yaml.
/**
 * Agent Team — Dispatcher-only orchestrator with grid dashboard
 *
 * The primary Pi agent has NO codebase tools. It can ONLY delegate work
 * to specialist agents via the `dispatch_agent` tool. Each specialist
 * maintains its own Pi session for cross-invocation memory.
 *
 * Loads agent definitions from agents/*.md, .claude/agents/*.md, .pi/agents/*.md.
 * Teams are defined in .pi/agents/teams.yaml — on boot a select dialog lets
 * you pick which team to work with. Only team members are available for dispatch.
 *
 * Commands:
 *   /agents-team          — switch active team
 *   /agents-list          — list loaded agents
 *   /agents-grid N        — set column count (default 2)
 *   /agents-clear         — clear agent team widget from screen
 *   Alt+G                 — toggle compact/expanded widget view
 *
 * Usage: pi -e extensions/agent-team.ts -e extensions/footer.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerToolWithExecutor } from "./lib/tool-executor-registry.ts";
import { Type } from "@sinclair/typebox";
import { Text, type AutocompleteItem, visibleWidth, truncateToWidth, Container, Spacer, Box, Markdown, matchesKey, Key, type Component } from "@mariozechner/pi-tui";
import { DynamicBorder, getMarkdownTheme as getPiMdTheme } from "@mariozechner/pi-coding-agent";
import { readdirSync, readFileSync, existsSync, mkdirSync, unlinkSync, rmSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { applyExtensionDefaults } from "./lib/themeMap.ts";
import { modePromptMatches } from "./lib/mode-cycler-logic.ts";
import { GRILL_ME_SECTION, ORCHESTRATED_TASK_PROMPT, RESEARCH_ROUTING_PROMPT } from "./lib/mode-prompts.ts";
import { coordinationState, onCoordinationModeChange } from "./lib/coordination-state.ts";
import { childEnvironment, ensurePiTool } from "./lib/child-runtime.ts";
import { subagentContextBudget } from "./lib/context-budget.ts";

import { statusButton } from "./lib/pipeline-render.ts";
import { DEFAULT_SUBAGENT_MODEL } from "./lib/defaults.ts";
import { loadAgentModelsConfig, loadToolkitModelsConfig, resolveAgentModelString, scanToolkitAgentDefs, type AgentModelsConfig } from "./lib/agent-defs.ts";
import { appendBoundedOutput, resolveToolkitWorkerModel, isToolkitCliAgent, parseToolkitResult, toolkitRuntimeName, runToolkitDispatch } from "./lib/toolkit-cli.ts";
import { buildMailboxPreamble, listSteer, mailboxPreambleEnabled } from "./lib/fleet-mailbox.ts";
import { padRight, wordWrap, sideBySide } from "./lib/ui-helpers.ts";
import { contextBudgetLevel, isContextLossError } from "./lib/context-budget.ts";
import { boundedOutputPreview, buildAgentResultContractPrompt, composeAgentResult, extractResultBlock, persistFullOutput, resultOneLiner, runBaseName } from "./lib/agent-result-contract.ts";
import { journalAppend, journalList, journalUpdate, pruneRunArtifacts, reconcileJournal, registerTaskStatusCommand, type TaskJournalEntry } from "./lib/agent-task-journal.ts";
import { readLastAssistantText, sessionUsage, countSessionToolCalls, updateHerdrPaneStatus, registerHerdrCommands, herdrWorkerLabel } from "./lib/herdr-client.ts";
import { currentDispatchAuthorization, explicitDispatchHandler, isExplicitDispatchActive, run as runDispatch, withSessionLifecycle } from "./lib/dispatch-runtime.ts";
import { matchNamedOption } from "./lib/named-pick.ts";
import { applyWorkerLaunchPolicy, implementationWorkerPrompt, isExecutionWorker, workerHitToolCap } from "./lib/worker-budget.ts";
import { discoverResearchTools } from "./lib/research-protocol.ts";
import { renderTaskList, navDown, navUp, navExit, navEnter, revealIncompleteTasks, type TaskListInfo, type TaskListState } from "./lib/task-list-render.ts";
import { renderSubagentWidget } from "./lib/subagent-render.ts";
import { normalizeRunStatus } from "./lib/run-state.ts";
import { createWorkerLifecycle } from "./lib/worker-lifecycle.ts";
import { createOrchestrationRun, DEFAULT_ORCHESTRATION_TIMEOUT_MS, type OrchestrationRun } from "./lib/orchestration-run.ts";
import { projectTeamBatchRecovery } from "./lib/team-batch-recovery.ts";


// ── Types ────────────────────────────────────────

interface AgentDef {
	name: string;
	description: string;
	tools: string;
	model: string; // full provider/model ID, empty = inherit parent
	systemPrompt: string;
	file: string;
}

interface AgentState {
	def: AgentDef;
	status: "idle" | "running" | "done" | "error";
	task: string;
	toolCount: number;
	elapsed: number;
	lastWork: string;
	contextPct: number;
	sessionFile: string | null;
	runCount: number;
	resolvedModel: string;
	timer?: ReturnType<typeof setInterval>;
	_warnSent?: boolean;
	_criticalWarned?: boolean;
	widgetId: number;           // unique ID for subagent-style widget
	textChunks: string[];       // streaming text for widget summary
	summary?: string;           // short summary shown in widget
	summaryLines?: string[];    // up to 2 recent CLI/output lines for richer widget preview
	proc?: any;                 // ChildProcess ref for escape-cancel
}

// ── Display Name Helper ──────────────────────────

function displayName(name: string): string {
	return name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function abbreviateAgentName(name: string): string {
	const parts = name.split("-");
	if (parts.length > 1) {
		// Multi-word: take first letter of each word and uppercase
		return parts.map(w => w.charAt(0).toUpperCase()).join("");
	} else {
		// Single-word: uppercase the entire name
		return name.toUpperCase();
	}
}

// ── Teams YAML Parser ────────────────────────────

function parseTeamsYaml(raw: string): Record<string, string[]> {
	const teams: Record<string, string[]> = {};
	let current: string | null = null;
	for (const line of raw.split("\n")) {
		const teamMatch = line.match(/^(\S[^:]*):$/);
		if (teamMatch) {
			current = teamMatch[1].trim();
			teams[current] = [];
			continue;
		}
		const itemMatch = line.match(/^\s+-\s+(.+)$/);
		if (itemMatch && current) {
			teams[current].push(itemMatch[1].trim());
		}
	}
	return teams;
}

/** Prefer a small coding team over the kitchen-sink `all` roster. */
export function defaultTeamName(teams: Record<string, string[]>): string | undefined {
	const names = Object.keys(teams);
	if (names.includes("plan-build")) return "plan-build";
	const small = names.find((n) => n !== "all" && n !== "full" && (teams[n]?.length ?? 0) > 0 && (teams[n]?.length ?? 0) <= 5);
	return small || names[0];
}

// ── Frontmatter Parser ───────────────────────────

function parseAgentFile(filePath: string, modelsConfig?: AgentModelsConfig): AgentDef | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!match) return null;

		const frontmatter: Record<string, string> = {};
		for (const line of match[1].split("\n")) {
			const idx = line.indexOf(":");
			if (idx > 0) {
				frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
			}
		}

		if (!frontmatter.name) return null;

		// Model resolution: models.json > frontmatter fallback > empty
		let model = "";
		if (modelsConfig) {
			const key = frontmatter.name.toLowerCase();
			const entry = modelsConfig.agents[key];
			if (entry) {
				model = resolveAgentModelString(frontmatter.name, modelsConfig);
			}
		}
		if (!model && frontmatter.model) {
			model = frontmatter.model;
		}

		return {
			name: frontmatter.name,
			description: frontmatter.description || "",
			tools: frontmatter.tools || "read,grep,find,ls",
			model,
			systemPrompt: match[2].trim(),
			file: filePath,
		};
	} catch {
		return null;
	}
}

function scanAgentDirs(cwd: string, extProjectDir?: string, modelsConfig?: AgentModelsConfig): AgentDef[] {
	const dirs = [
		join(cwd, "agents"),
		join(cwd, ".claude", "agents"),
		join(cwd, ".pi", "agents"),
		...(extProjectDir ? [join(extProjectDir, ".pi", "agents"), join(extProjectDir, "agents")] : []),
	];

	const agents: AgentDef[] = [];
	const seen = new Set<string>();

	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			const scan = (d: string) => {
				for (const file of readdirSync(d, { withFileTypes: true })) {
					const fullPath = resolve(d, file.name);
					if (file.isDirectory()) {
						scan(fullPath);
					} else if (file.name.endsWith(".md")) {
						const def = parseAgentFile(fullPath, modelsConfig);
						if (def && !seen.has(def.name.toLowerCase())) {
							seen.add(def.name.toLowerCase());
							agents.push(def);
						}
					}
				}
			};
			scan(dir);
		} catch {}
	}

	return agents;
}

// ── Extension ────────────────────────────────────

export default function (pi: ExtensionAPI) {
	registerHerdrCommands(pi);
	const agentStates: Map<string, AgentState> = new Map();
	const lifecycle = createWorkerLifecycle();
	let allAgentDefs: AgentDef[] = [];
	let teams: Record<string, string[]> = {};
	let activeTeamName = "";
	let gridCols = 2;
	let widgetCtx: any;
	let unwatchMode: (() => void) | undefined;
	let sessionEpoch = 0;
	let sessionDir = "";
	let contextWindow = 0;
	let widgetCompact = true;
	let selectedAgentIndex = -1; // -1 = no selection
	let taskListState: TaskListState = { selectedIndex: -1, scrollOffset: 0 };
	let taskListWidget: { invalidate: () => void } | undefined;
	let taskListTui: { requestRender?: () => void } | undefined;
	let nextWidgetId = 1;
	const agentWidgetBoxes = new Map<number, { invalidate: () => void }>();

	function isStaleCtxError(err: any): boolean {
		const msg = String(err?.message ?? err ?? "");
		return msg.includes("ctx is stale") || msg.includes("stale after session");
	}

	function safeUi(ctx: any, op: (ui: any) => void): boolean {
		if (!ctx || ctx.hasUI === false || !ctx.ui) return false;
		try {
			op(ctx.ui);
			return true;
		} catch (err: any) {
			if (isStaleCtxError(err)) {
				if (widgetCtx === ctx) widgetCtx = undefined;
				return false;
			}
			throw err;
		}
	}

	function safeNotify(ctx: any, message: string, type?: string): void {
		safeUi(ctx, (ui) => ui.notify(message, type));
	}

	function safeSetStatus(ctx: any, key: string, value: string): void {
		safeUi(ctx, (ui) => ui.setStatus(key, value));
	}

	function safeSetWidget(ctx: any, key: string, renderer: any, options?: any): boolean {
		return safeUi(ctx, (ui) => {
			if (options === undefined) {
				ui.setWidget(key, renderer);
			} else {
				ui.setWidget(key, renderer, options);
			}
		});
	}

	// ── Dark background colors for agent status (matches subagent-widget) ────
	const STATUS_BG: Record<string, string> = {
		running: "\x1b[48;2;26;58;92m",   // dark steel blue
		done:    "\x1b[48;2;35;50;55m",    // dark teal-gray
		error:   "\x1b[48;2;70;35;35m",    // dark muted red
	};
	const RESET_BG = "\x1b[49m";
	const WHITE_BOLD = "\x1b[1;97m";  // bold bright white text
	const RESET_ALL = "\x1b[0m";

	function loadAgents(cwd: string) {
		const extDir = dirname(fileURLToPath(import.meta.url));
		const securityGuardExtPath = join(extDir, "security-guard.ts");
		const extProjectDir = resolve(extDir, "..");

		// Create session storage dir
		sessionDir = join(cwd, ".pi", "agent-sessions");
		if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
		pruneRunArtifacts(sessionDir); // 7-day rolling retention (archives + journal)
		reconcileJournal(sessionDir); // close rows orphaned by a crashed parent

		// Load standard + toolkit model config, then scan agent .md files
		const modelsConfig = loadAgentModelsConfig(cwd, extProjectDir);
		const toolkitModelsConfig = loadToolkitModelsConfig(cwd, extProjectDir);
		const standardAgentDefs = scanAgentDirs(cwd, extProjectDir, modelsConfig);
		const toolkitAgentDefs = Array.from(scanToolkitAgentDefs(cwd, extProjectDir, toolkitModelsConfig).values());
		const merged = new Map<string, AgentDef>();
		for (const def of [...standardAgentDefs, ...toolkitAgentDefs]) {
			if (!merged.has(def.name.toLowerCase())) merged.set(def.name.toLowerCase(), def);
		}
		allAgentDefs = Array.from(merged.values());

		// Load teams from .pi/agents/teams.yaml (fallback to extension project dir)
		let teamsPath = join(cwd, ".pi", "agents", "teams.yaml");
		if (!existsSync(teamsPath)) {
			teamsPath = join(extProjectDir, ".pi", "agents", "teams.yaml");
		}
		if (!existsSync(teamsPath)) {
			teamsPath = join(extProjectDir, "agents", "teams.yaml");
		}
		if (existsSync(teamsPath)) {
			try {
				teams = parseTeamsYaml(readFileSync(teamsPath, "utf-8"));
			} catch {
				teams = {};
			}
		} else {
			teams = {};
		}

		// If no teams defined, create a default "all" team
		if (Object.keys(teams).length === 0) {
			teams = { all: allAgentDefs.map(d => d.name) };
		}
	}

	function activateTeam(teamName: string) {
		activeTeamName = teamName;
		const members = teams[teamName] || [];
		const defsByName = new Map(allAgentDefs.map(d => [d.name.toLowerCase(), d]));

		removeAllAgentWidgets(widgetCtx);
		for (const state of agentStates.values()) {
			clearAgentTimer(state);
			if (state.status === "running" && state.proc) {
				try { state.proc.kill("SIGTERM"); } catch {}
			}
		}
		agentStates.clear();
		selectedAgentIndex = -1; // Reset selection when team changes
		for (const member of members) {
			const def = defsByName.get(member.toLowerCase());
			if (!def) continue;
			const key = def.name.toLowerCase().replace(/\s+/g, "-");
			const sessionFile = join(sessionDir, `${key}.json`);
			agentStates.set(def.name.toLowerCase(), {
				def,
				status: "idle",
				task: "",
				toolCount: 0,
				elapsed: 0,
				lastWork: "",
				contextPct: 0,
				sessionFile: existsSync(sessionFile) ? sessionFile : null,
				runCount: 0,
				resolvedModel: "",
				widgetId: nextWidgetId++,
				textChunks: [],
				summary: undefined,
				summaryLines: undefined,
			});
		}

		// Auto-size grid columns based on team size
		const size = agentStates.size;
		gridCols = size <= 3 ? size : size === 4 ? 2 : 3;
	}

	// ── Per-Agent Widget Rendering (subagent-style) ──────────────────

	function registerAgentWidget(state: AgentState, ctx = widgetCtx) {
		if (!ctx) return;
		const key = `agent-${state.widgetId}`;
		if (safeSetWidget(ctx, key, (_tui: any, theme: any) => {
			const bgFn = (text: string): string => {
				const bg = STATUS_BG[state.status] || STATUS_BG.running;
				return `${bg}${WHITE_BOLD}${text}${RESET_ALL}${RESET_BG}`;
			};

			const box = new Box(1, 1, bgFn);
			const content = new Text("", 0, 0);
			box.addChild(content);
			agentWidgetBoxes.set(state.widgetId, { invalidate: () => box.invalidate() });

			return {
				render(width: number): string[] {
					box.setBgFn((text: string): string => {
						const bg = STATUS_BG[state.status] || STATUS_BG.running;
						return `${bg}${WHITE_BOLD}${text}${RESET_ALL}${RESET_BG}`;
					});

					const renderState = {
						id: state.widgetId,
						status: state.status as "running" | "done" | "error",
						name: state.def.name.toUpperCase(),
						task: state.task,
						toolCount: state.toolCount,
						elapsed: state.elapsed,
						turnCount: state.runCount,
						summary: state.summary,
						summaryLines: state.summaryLines,
						model: state.resolvedModel || state.def.model || undefined,
					};
					const result = renderSubagentWidget(renderState, width, theme);
					content.setText(result.lines.join("\n"));
					return box.render(width);
				},
				invalidate() {
					box.invalidate();
				},
			};
		})) {
			widgetCtx = ctx;
		}
	}

	function invalidateAgentWidget(state: AgentState) {
		agentWidgetBoxes.get(state.widgetId)?.invalidate();
	}

	function removeAgentWidget(state: AgentState, ctx = widgetCtx) {
		if (!ctx) return;
		safeSetWidget(ctx, `agent-${state.widgetId}`, undefined);
		agentWidgetBoxes.delete(state.widgetId);
	}

	function removeAllAgentWidgets(ctx = widgetCtx) {
		if (!ctx) return;
		for (const state of agentStates.values()) {
			safeSetWidget(ctx, `agent-${state.widgetId}`, undefined);
		}
		agentWidgetBoxes.clear();
	}

	// ── Combined Widget (task list only) ──────────────────────────────

	function updateWidget(ctx = widgetCtx) {
		if (!ctx) return;
		widgetCtx = ctx;

		// Task list widget (above editor)
		const taskList = (globalThis as any).__piTaskList as TaskListInfo | null;
		if (taskList && taskList.tasks.length > 0) {
			taskListState = revealIncompleteTasks(taskListState, taskList.tasks);
			const mounted = safeSetWidget(ctx, "agent-team", (tui: any, theme: any) => {
				taskListTui = tui;
				const text = new Text("", 0, 0);
				const widget = {
					render(width: number): string[] {
						const tl = (globalThis as any).__piTaskList as TaskListInfo | null;
						if (!tl || tl.tasks.length === 0) {
							text.setText("");
							return [];
						}

						const termHeight = process.stdout.rows || 24;
						const availableHeight = Math.max(3, Math.min(termHeight - 10, 14));
						const taskLines = renderTaskList(
							tl, taskListState, width, availableHeight,
							{ truncateToWidth, fg: (c: string, t: string) => theme.fg(c, t) },
						);
						const taskBg = "\x1b[48;5;236m";
						const taskReset = "\x1b[0m";
						const emptyPad = taskBg + padRight("", width) + taskReset;
						const allLines: string[] = [];
						allLines.push(emptyPad);
						allLines.push(...taskLines.map(l => taskBg + padRight(l, width) + taskReset));
						allLines.push(emptyPad);

						text.setText(allLines.join("\n"));
						return allLines;
					},
					invalidate() {
						text.invalidate();
					},
				};
				taskListWidget = widget;
				return widget;
			}, { placement: "aboveEditor" });
			if (mounted) {
				taskListWidget?.invalidate();
				taskListTui?.requestRender?.();
			}
		} else {
			// No task list — remove the combined widget
			taskListWidget = undefined;
			taskListTui = undefined;
			safeSetWidget(ctx, "agent-team", undefined);
		}

		// Individual agent widgets are managed separately via registerAgentWidget/invalidateAgentWidget

		// Re-pin mode bar as the last aboveEditor widget so it stays directly above the editor input.
		// Without this, the agent-team widget (tasks) would render between the mode bar and the editor.
		try {
			(globalThis as any).__piRefreshModeBlock?.();
		} catch (err: any) {
			if (!isStaleCtxError(err)) throw err;
		}
	}

	// ── Dispatch Agent (returns Promise) ─────────

	function dispatchAgent(
		agentName: string,
		task: string,
		ctx: any,
		parentRunId?: string,
		signal?: AbortSignal,
		parentRun?: OrchestrationRun,
	): Promise<{ output: string; fullOutput: string; fullOutputPath: string; exitCode: number; elapsed: number; model: string }> {
		if (!isExplicitDispatchActive()) {
			return Promise.resolve({ output: "Dispatch refused: only an explicit tool or slash command may start a child", fullOutput: "", fullOutputPath: "", exitCode: 126, elapsed: 0, model: "" });
		}
		const key = agentName.toLowerCase();
		const state = agentStates.get(key);
		if (!state) {
			return Promise.resolve({
				output: `Agent "${agentName}" not found. Available: ${Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ")}`,
				fullOutput: "",
				fullOutputPath: "",
				exitCode: 1,
				elapsed: 0,
				model: "",
			});
		}

		if (state.status === "running") {
			return Promise.resolve({
				output: `Agent "${displayName(state.def.name)}" is already running. Wait for it to finish.`,
				fullOutput: "",
				fullOutputPath: "",
				exitCode: 1,
				elapsed: 0,
				model: "",
			});
		}

		const runEpoch = sessionEpoch;
		const runCwd = ctx?.cwd || process.cwd();
		if (ctx?.hasUI) widgetCtx = ctx;

		state.status = "running";
		state.task = task;
		state.toolCount = 0;
		state.elapsed = 0;
		state.lastWork = "";
		state.textChunks = [];
		state.summary = undefined;
		state.summaryLines = undefined;
		state.runCount++;
		safeNotify(ctx, `${displayName(state.def.name)} started`, "info");
		registerAgentWidget(state, ctx);
		updateWidget(ctx);

		const startTime = Date.now();
		const timer = setInterval(() => {
			if (runEpoch !== sessionEpoch) {
				clearInterval(timer);
				return;
			}
			state.elapsed = Date.now() - startTime;
			const sessionPath = join(sessionDir, `${state.def.name.toLowerCase().replace(/\s+/g, "-")}.json`);
			const n = countSessionToolCalls(sessionPath);
			if (n > state.toolCount) state.toolCount = n;
			invalidateAgentWidget(state);
		}, 1000);
		state.timer = lifecycle.trackTimer(timer);

		// Use agent's defined model or fall back to default subagent model.
		// NOTE: We intentionally do NOT inherit the parent model. Each agent
		// should use its explicitly defined model or the lightweight default.
		const model = resolveToolkitWorkerModel(state.def.name, state.def.model || DEFAULT_SUBAGENT_MODEL);
		state.resolvedModel = model;

		// Session file for this agent
		const agentKey = state.def.name.toLowerCase().replace(/\s+/g, "-");
		const agentSessionFile = join(sessionDir, `${agentKey}.json`);


		// Build args — first run creates session, subsequent runs resume
		const extDir = dirname(fileURLToPath(import.meta.url));
		const herdrDoneExtPath = join(extDir, "herdr-done.ts");

		const canonicalName = state.def.name;

		// Purge stale steer mails from a previous (dead) run so a fresh task
		// never inherits mid-task course corrections that no longer apply.
		try {
			for (const { path } of listSteer(join(runCwd, ".pi", "agent-sessions", "mailbox"), canonicalName)) {
				rmSync(path, { force: true });
			}
		} catch {}
		let tools = state.def.tools;
		if (canonicalName.toLowerCase() === "researcher") {
			for (const name of discoverResearchTools(pi.getAllTools())) tools = ensurePiTool(tools, name);
		}
		if (!isToolkitCliAgent(canonicalName)) tools = ensurePiTool(tools, "ask_parent");
		let systemPrompt = state.def.systemPrompt;

		if (!isToolkitCliAgent(canonicalName)) {
			systemPrompt += buildAgentResultContractPrompt();
			if (isExecutionWorker(canonicalName)) systemPrompt += implementationWorkerPrompt();
		}

		// Durable journal record — survives parent restarts (see /agents-status).
		const journalId = runBaseName(agentKey, state.runCount);
		journalAppend(sessionDir, {
			version: 1,
			id: journalId,
			orchestrationRunId: parentRunId,
			kind: "team",
			agent: canonicalName,
			mode: coordinationState().mode,
			runtime: isToolkitCliAgent(canonicalName) ? toolkitRuntimeName(canonicalName) : undefined,
			task,
			model: isToolkitCliAgent(canonicalName) ? undefined : model,
			cwd: runCwd,
			sessionFile: isToolkitCliAgent(canonicalName) ? undefined : (state.sessionFile || undefined),
			resumed: !!state.sessionFile,
			status: "dispatched",
			startedAt: Date.now(),
			updatedAt: Date.now(),
		});

		const baseArgs = [
			"--model", model,
			"--tools", tools,
			"--append-system-prompt", systemPrompt,
			"--session", agentSessionFile,
		];
		// Headless JSON args for the invisible spawn paths; the herdr visible
		// transport drops "--mode json"/"-p" so operators watch the real TUI.
		let args = ["--mode", "json", "-p", ...baseArgs];

		// Continue existing session if we have one
		if (state.sessionFile) {
			args.push("-c");
		}

		args.push(task);

		const textChunks: string[] = [];
		let liveText = "";

		return new Promise((resolve) => {
			// Build the least-privilege worker environment.
			const paneTitle = herdrWorkerLabel(state.def.name, journalId);
			const spawnEnv: Record<string, string | undefined> = childEnvironment({
				PI_SUBAGENT: "1",
				PI_AGENT_NAME: displayName(state.def.name).toLowerCase(),
				PI_PANE_TITLE: paneTitle,
				PI_SESSION_FILE: state.sessionFile || undefined,
				PI_AGENT_PI_RUN_ID: parentRunId,
			});
			let toolkitUsage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; costUsd: number } | undefined;
			let toolkitModel: string | undefined;
			let finished = false;
			const finish = (code: number | null, stderrBuf: string, externalFull?: string) => {
				if (finished) return;
				finished = true;
				clearInterval(timer);
				if (state.timer === timer) state.timer = undefined;

				let full = externalFull ?? textChunks.join("");
				if ((code !== 0 && code !== null) && stderrBuf.trim()) {
					if (isContextLossError(stderrBuf)) {
						full = "Context overflow: agent session broke tool_use/tool_result pairing. Clear session and re-dispatch.";
					} else {
						full = full.trim() ? `${full}\n\n--- stderr ---\n${stderrBuf.trim()}` : stderrBuf.trim();
					}
				}

				const elapsed = Date.now() - startTime;
				if (runEpoch !== sessionEpoch) {
					journalUpdate(sessionDir, journalId, {
						status: code === 0 ? "done" : "error",
						runStatus: code === 130 ? "cancelled" : undefined,
						exitCode: code,
						elapsedMs: elapsed,
						outputFile: "",
					});
					resolve({ output: full, fullOutput: full, fullOutputPath: "", exitCode: code ?? 1, elapsed, model });
					return;
				}

				lifecycle.clearProcess(state.proc);
				state.proc = null;
				updateHerdrPaneStatus(runCwd, journalId, code === 0 ? "done" : "error");
				state.elapsed = elapsed;
				state.status = code === 0 ? "done" : "error";

				if (code === 0 && !isToolkitCliAgent(canonicalName)) {
					state.sessionFile = agentSessionFile;
				} else if (isContextLossError(stderrBuf)) {
					state.sessionFile = null;
				}

				// Persist the FULL transcript on disk (never lost), then compose the
				// compact-but-complete result index for the parent context.
				let fullOutputPath = "";
				let composed = full;
				try {
					fullOutputPath = persistFullOutput(sessionDir, runBaseName(agentKey, state.runCount), full);
					composed = composeAgentResult({
						agent: canonicalName,
						status: state.status,
						exitCode: code,
						elapsedMs: elapsed,
						model: toolkitModel || model,
						outputText: full,
						fullOutputPath,
						maxResultChars: subagentContextBudget(ctx?.getContextUsage?.()?.percent, 1).resultChars,
						skipContract: isToolkitCliAgent(canonicalName),
					}).content;
				} catch (err: any) {
					composed = full; // persistence failure must never lose the result itself
					fullOutputPath = "";
				}

				state.lastWork = resultOneLiner(full, extractResultBlock(full).result)
					|| full.split("\n").filter((l: string) => l.trim() && l.trim() !== "## END" && l.trim() !== "## RESULT").pop()
					|| "";
				state.summary = resultOneLiner(full, extractResultBlock(full).result) || state.lastWork;
				if (state.toolCount === 0 && state.sessionFile) {
					state.toolCount = countSessionToolCalls(state.sessionFile);
				}
				state.summaryLines = full.split("\n").map((l: string) => l.trim()).filter(Boolean).slice(-3);
				invalidateAgentWidget(state);

				const tu = toolkitUsage ?? (state.sessionFile ? sessionUsage(state.sessionFile) : null);
				if (toolkitModel) state.resolvedModel = toolkitModel;
				if (parentRun && tu && tu.totalTokens > 0) {
					parentRun.recordUsage({ totalTokens: tu.totalTokens, costUsd: tu.costUsd });
				}
				journalUpdate(sessionDir, journalId, {
					status: state.status,
					exitCode: code,
					elapsedMs: state.elapsed,
					model: toolkitModel || (isToolkitCliAgent(canonicalName) ? undefined : model),
					sessionFile: isToolkitCliAgent(canonicalName) ? undefined : (state.sessionFile || undefined),
					outputFile: fullOutputPath || undefined,
					usage: tu && tu.totalTokens > 0 ? {
						input: tu.input, output: tu.output, cacheRead: tu.cacheRead, cacheWrite: tu.cacheWrite,
						totalTokens: tu.totalTokens, costUsd: Math.round(tu.costUsd * 1e6) / 1e6,
					} : undefined,
				});

				setTimeout(() => {
					if (runEpoch === sessionEpoch && state.status !== "running") removeAgentWidget(state, ctx);
				}, 30_000);

				safeNotify(
					ctx,
					`${displayName(state.def.name)} ${state.status} in ${Math.round(state.elapsed / 1000)}s`,
					state.status === "done" ? "success" : "error"
				);

				resolve({ output: composed, fullOutput: full, fullOutputPath, exitCode: code ?? 1, elapsed: state.elapsed, model });
			};

			const handleStdoutLine = (line: string) => {
				if (runEpoch !== sessionEpoch) return;
				try {
					const event = JSON.parse(line);
					if (event.type === "message_update") {
						const delta = event.assistantMessageEvent;
						if (delta?.type === "text_delta") {
							const deltaText = delta.delta || "";
							textChunks.push(deltaText);
							state.textChunks.push(deltaText);
							liveText = (liveText + deltaText).slice(-8_192);
							const full = liveText;
							const last = full.split("\n").filter((l: string) => l.trim()).pop() || "";
							state.lastWork = last;
							state.summary = last;
							state.summaryLines = full.split("\n").map((l: string) => l.trim()).filter(Boolean).slice(-3);
							invalidateAgentWidget(state);
						}
					} else if (event.type === "tool_execution_start") {
						state.toolCount++;
						if (workerHitToolCap(canonicalName, state.toolCount) && state.proc) {
							try { state.proc.kill("SIGTERM"); } catch {}
							state.lastWork = "stopped: tool-call cap";
						}
						invalidateAgentWidget(state);
					} else if (event.type === "message_end") {
						const msg = event.message;
						if (msg?.usage && contextWindow > 0) {
							state.contextPct = ((msg.usage.input || 0) / contextWindow) * 100;
							const level = contextBudgetLevel(state.contextPct);
							if (level === "warn" && !state._warnSent) {
								state._warnSent = true;
								safeNotify(ctx, `${displayName(state.def.name)} Context: ${Math.round(state.contextPct)}%`, "info");
							} else if (level === "critical" && !state._criticalWarned) {
								state._criticalWarned = true;
								safeNotify(ctx, `${displayName(state.def.name)} Context: ${Math.round(state.contextPct)}% — Agent will Cycle-Memory soon`, "info");
							}
							invalidateAgentWidget(state);
						}
					} else if (event.type === "agent_end") {
						const msgs = event.messages || [];
						const last = [...msgs].reverse().find((m: any) => m.role === "assistant");
						if (last?.usage && contextWindow > 0) {
							state.contextPct = ((last.usage.input || 0) / contextWindow) * 100;
							invalidateAgentWidget(state);
						}
					}
				} catch {}
			};

			let stderrBuf = "";
			if (isToolkitCliAgent(state.def.name)) {
				const extTask = mailboxPreambleEnabled()
					? `${buildMailboxPreamble(canonicalName || state.def.name, runCwd)}\n\n---\n\n${task}`
					: task;
				void runToolkitDispatch({
					agentName: state.def.name,
					task: extTask,
					cwd: runCwd,
					env: spawnEnv,
					sessionDir,
					runId: journalId,
					parentRunId,
					mode: "TEAM",
					timeoutMs: DEFAULT_ORCHESTRATION_TIMEOUT_MS,
					journal: { dir: sessionDir, id: journalId },
					paneTitle,
					isCancelled: () => runEpoch !== sessionEpoch || !!signal?.aborted,
					onProcess: (proc: any) => { state.proc = lifecycle.trackProcess(proc); },
					onStdoutLine: handleStdoutLine,
					onStderr: (chunk: string) => { stderrBuf = appendBoundedOutput(stderrBuf, chunk); },
				}).then(({ exitCode, raw }) => {
					const parsed = parseToolkitResult(state.def.name, raw);
					toolkitUsage = parsed.usage;
					if (parsed.model) toolkitModel = parsed.model;
					if (!parsed.text && stderrBuf.trim()) parsed.text = stderrBuf.trim();
					finish(exitCode, stderrBuf, parsed.text || raw || undefined);
				}).catch((err) => {
					finish(1, stderrBuf, err instanceof Error ? err.message : String(err));
				});
				return;
			}

			// Standard Pi transport is centralized. Team-specific state, context
			// warnings and result composition stay here.
			const launch = applyWorkerLaunchPolicy(["pi", ...args], canonicalName);
			runDispatch({
				authorization: currentDispatchAuthorization(),
				command: launch.command,
				cwd: runCwd,
				env: spawnEnv,
				launchDir: sessionDir,
				launchId: journalId,
				parentRunId,
				mode: "TEAM",
				pollTimeoutMs: DEFAULT_ORCHESTRATION_TIMEOUT_MS,
				sessionFile: agentSessionFile,
				herdrDoneExtPath,
				herdrLabel: paneTitle,
				herdrPaneKey: journalId,
				journal: { dir: sessionDir, id: journalId },
				isAborted: () => runEpoch !== sessionEpoch || !!signal?.aborted,
					onProcess: (child) => { state.proc = lifecycle.trackProcess(child as any); },
				onStdoutLine: handleStdoutLine,
				onStderr: (chunk) => { stderrBuf = appendBoundedOutput(stderrBuf, chunk); },
				onHerdrUpdate: () => {
					if (runEpoch !== sessionEpoch) return;
					try {
						const { text } = readLastAssistantText(agentSessionFile);
						const last = text.split("\n").filter((l: string) => l.trim()).pop() || "";
						if (last) {
							state.lastWork = last;
							state.summary = last;
						}
						const n = countSessionToolCalls(agentSessionFile);
						if (n > state.toolCount) state.toolCount = n;
						invalidateAgentWidget(state);
					} catch {}
				},
			}).then((result) => {
				finish(result.exitCode, result.stderr, result.outputText);
			}).catch((error) => {
				finish(1, error instanceof Error ? error.message : String(error));
			});

		});
	}

	// ── dispatch_agent Tool (registered at top level) ──

	registerToolWithExecutor(pi, {
		name: "dispatch_agent",
		label: "Dispatch Agent",
		description: "Dispatch a task to a specialist agent. The agent will execute the task and return the result. Use the system prompt to see available agent names. When reporting the outcome to the user: lead with the result and the next decision; do not narrate internal mechanics (tabs, polling, journal ids, transport details).",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name (case-insensitive)" }),
			task: Type.String({ description: "Task description for the agent to execute" }),
		}),

		execute: explicitDispatchHandler("agent-team", async (_toolCallId, params, signal, onUpdate, ctx) => {
			const { agent, task } = params as { agent: string; task: string };
			const defModel = agentStates.get(agent.toLowerCase())?.def.model || "";
			const orchestrationRun = createOrchestrationRun({ context: ctx, signal, actor: "agent-team", mode: "TEAM", budget: { maxSteps: 1 }, workspaceCwd: ctx?.cwd });
			orchestrationRun.record("team.started", { agent, task });

			try {
				if (onUpdate) {
					onUpdate({
						content: [{ type: "text", text: `Dispatching to ${agent}...` }],
						details: { agent, task, status: "dispatching", model: defModel },
					});
				}

				orchestrationRun.consumeStep();
				const result = await dispatchAgent(agent, task, ctx, orchestrationRun.runId, orchestrationRun.signal, orchestrationRun);

				// result.output is already the composed, precision-preserving index
				// (status + ## RESULT block or tail/head fallback + full-output path).
				const status = result.exitCode === 0 ? "done" : "error";
				const summary = `[${agent}] ${status} in ${Math.round(result.elapsed / 1000)}s`;

				orchestrationRun.record("team.completed", { agent, exitCode: result.exitCode });
				orchestrationRun.finish(result.exitCode === 0 ? "succeeded" : "failed", { agent, exitCode: result.exitCode });
				return {
					content: [{ type: "text", text: `${summary}\n\n${result.output}` }],
					details: {
						runId: orchestrationRun.runId,
						agent,
						task,
						status,
						elapsed: result.elapsed,
						exitCode: result.exitCode,
						outputPreview: boundedOutputPreview(result.fullOutput),
						fullOutputPath: result.fullOutputPath,
						model: result.model,
					},
				};
			} catch (err: any) {
				orchestrationRun.record("team.failed", { agent, error: err?.message || String(err) });
				orchestrationRun.finish("failed", { agent });
				return {
					content: [{ type: "text", text: `Error dispatching to ${agent}: ${err?.message || err}` }],
					details: { runId: orchestrationRun.runId, agent, task, status: "error", elapsed: 0, exitCode: 1, outputPreview: "", fullOutputPath: "", model: defModel },
				};
			}
		}),

		renderResult(result, options, theme) {
			const details = result.details as any;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			const agent = (details.agent || "AGENT").toUpperCase();
			const model = details.model || "";
			const elapsed = typeof details.elapsed === "number" ? details.elapsed : 0;
			const rawStatus = details.status || "done";
			const normalizedStatus = normalizeRunStatus(rawStatus);
			const status: "running" | "done" | "error" = normalizedStatus === "running" || normalizedStatus === "queued"
				? "running"
				: normalizedStatus === "failed"
					? "error"
					: "done";

			const renderState = {
				id: 0,
				status,
				name: agent,
				task: details.task || "",
				toolCount: 0,
				elapsed,
				turnCount: 1,
				summary: `dispatching: ${agent.toLowerCase()}${model ? ` @ ${model}` : ""}`,
				model: model || undefined,
			};

			const rendered = renderSubagentWidget(renderState, options.width || 80, theme);
			const bg = STATUS_BG[status] || STATUS_BG.running;
			const bgFn = (text: string): string => `${bg}${WHITE_BOLD}${text}${RESET_ALL}${RESET_BG}`;
			const box = new Box(1, 1, bgFn);
			box.addChild(new Text(rendered.lines.join("\n"), 0, 0));

			if (options.expanded && details.outputPreview) {
				const output = details.outputPreview;
				const mdTheme = getPiMdTheme();
				const container = new Container();
				container.addChild(box);
				container.addChild(new Markdown(output, 2, 0, mdTheme));
				return container;
			}

			return box;
		},
	});

	registerToolWithExecutor(pi, {
		name: "dispatch_team_batch",
		label: "Dispatch Team Batch",
		description: "Dispatch multiple independent TEAM tasks concurrently and return bounded summaries in one call. Use only when tasks have separate owners and neither depends on another result; use dispatch_agent for sequential work.",
		parameters: Type.Object({
			jobs: Type.Array(Type.Object({
				agent: Type.String({ maxLength: 160, description: "Team member name (case-insensitive)" }),
				task: Type.String({ maxLength: 4_000, description: "Independent task for this team member" }),
			}), { maxItems: 8, description: "Independent jobs to run concurrently (maximum 8)" }),
		}),

		execute: explicitDispatchHandler("agent-team-batch", async (_toolCallId, params, signal, onUpdate, ctx) => {
			const requested = Array.isArray((params as any)?.jobs) ? (params as any).jobs : [];
			if (requested.length === 0) {
				return { content: [{ type: "text", text: "Error: jobs must contain at least one independent team task." }] };
			}
			const jobs = requested.slice(0, 8) as Array<{ agent: string; task: string }>;
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Team batch cancelled before dispatch." }], details: { status: "cancelled", jobs: 0 } };
			}
			const orchestrationRun = createOrchestrationRun({
				context: ctx,
				signal,
				actor: "agent-team-batch",
				mode: "TEAM",
				budget: { maxSteps: jobs.length },
				workspaceCwd: ctx?.cwd,
			});
			orchestrationRun.record("team.batch.started", { jobs: jobs.map((job) => job.agent) });
			onUpdate?.({ content: [{ type: "text", text: `Dispatching ${jobs.length} independent TEAM tasks concurrently...` }] });
			const results = await Promise.all(jobs.map(async (job) => {
				orchestrationRun.consumeStep();
				try {
					const result = await dispatchAgent(job.agent, job.task, ctx, orchestrationRun.runId, orchestrationRun.signal, orchestrationRun);
					return { agent: job.agent, task: job.task, status: result.exitCode === 0 ? "done" : "error", ...result };
				} catch (error: any) {
					return { agent: job.agent, task: job.task, status: "error", output: error?.message || String(error), fullOutput: "", fullOutputPath: "", exitCode: 1, elapsed: 0, model: "" };
				}
			}));
			const failed = results.filter((result) => result.status !== "done").length;
			const cancelled = signal?.aborted || results.some((result) => result.exitCode === 130);
			orchestrationRun.record("team.batch.completed", { total: results.length, failed, cancelled });
			orchestrationRun.finish(cancelled ? "cancelled" : failed > 0 ? "failed" : "succeeded", { total: results.length, failed });
			const summary = [
				`TEAM batch ${cancelled ? "cancelled" : failed > 0 ? "finished with failures" : "succeeded"}: ${results.length - failed}/${results.length} jobs completed.`,
				...results.map((result) => {
				const label = `[${result.agent}] ${result.status} in ${Math.round(result.elapsed / 1000)}s`;
				const resultBlock = extractResultBlock(result.fullOutput).result;
				const detail = resultOneLiner(result.fullOutput, resultBlock) || result.output.replace(/\s+/g, " ").slice(0, 240) || "no summary";
				const archive = result.fullOutputPath ? `; archive: ${result.fullOutputPath}` : "; archive: unavailable";
				return `${label} — ${detail}${archive}`;
			}),
			].join("\n").slice(0, 8_000);
			return {
				content: [{ type: "text", text: summary }],
				details: {
					runId: orchestrationRun.runId,
					status: cancelled ? "cancelled" : failed > 0 ? "failed" : "succeeded",
					jobs: results.map(({ agent, task, status, elapsed, exitCode, fullOutputPath, model }) => ({ agent, task: task.slice(0, 240), status, elapsed, exitCode, fullOutputPath, model })),
				},
			};
		}),
	});

	registerToolWithExecutor(pi, {
		name: "team_batch_recover",
		label: "Recover Team Batch",
		description: "Inspect a stale TEAM batch and return bounded worker resume candidates. Read-only: it never dispatches or mutates work; explicitly use dispatch_agent for selected candidates after re-checking the workspace.",
		parameters: Type.Object({
			run_id: Type.String({ maxLength: 128, description: "Persisted TEAM batch RunContext id" }),
		}),
		capabilityRisk: "read",
		capabilityEffect: { ordering: "commutative" },
		execute: async (_callId, args, _signal, _onUpdate, ctx) => {
			const runId = String(args.run_id || "");
			const sessionRoot = resolve(join(ctx?.cwd || process.cwd(), ".pi", "agent-sessions"));
			const entries = journalList(sessionRoot).filter((entry: TaskJournalEntry) => entry.kind === "team" && entry.orchestrationRunId === runId);
			if (entries.length === 0) {
				return { content: [{ type: "text", text: `No TEAM batch workers found for ${runId}.` }], details: { found: false, runId } };
			}
			const candidates = projectTeamBatchRecovery(entries, sessionRoot);
			const resumable = candidates.filter((candidate) => candidate.canResume);
			const lines = [
				`TEAM batch ${runId}: ${resumable.length}/${candidates.length} worker(s) have a safe persisted session to resume.`,
				...candidates.map((candidate) => `${candidate.status.padEnd(10)} ${candidate.agent} ${candidate.id}${candidate.canResume ? " resumable — dispatch_agent after workspace re-check" : " inspect/re-dispatch required"} task=${candidate.task.replace(/\s+/g, " ")}`),
			];
			return { content: [{ type: "text", text: lines.join("\n").slice(0, 8_000) }], details: { found: true, runId, candidates } };
		},
	});

	// ── Commands ─────────────────────────────────

	registerTaskStatusCommand(pi, () => sessionDir);

	pi.registerCommand("agents-team", {
		description: "Select a team: /agents-team or /agents-team <name>",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = Object.keys(teams).map((name) => ({ value: name, label: name }));
			const filtered = items.filter((item) => item.value.startsWith(prefix.trim()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			widgetCtx = ctx;
			const teamNames = Object.keys(teams);
			if (teamNames.length === 0) {
				safeNotify(ctx, "No teams defined in .pi/agents/teams.yaml", "warning");
				return;
			}

			const named = matchNamedOption(teamNames, args || "");
			let name = named;
			if (!name) {
				const options = teamNames.map(n => {
					const members = teams[n].map(m => displayName(m));
					return `${n} — ${members.join(", ")}`;
				});
				const choice = await ctx.ui.select("Select Team", options);
				if (choice === undefined) return;
				name = teamNames[options.indexOf(choice)];
			}
			if (!name) return;
			activateTeam(name);
			updateWidget();
			safeSetStatus(ctx, "agent-team", `Team: ${name} (${agentStates.size})`);
			safeNotify(ctx, `Team: ${name} — ${Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ")}`, "info");
		},
	});

	pi.registerCommand("agents-list", {
		description: "List all loaded agents",
		handler: async (_args, _ctx) => {
			widgetCtx = _ctx;
			const names = Array.from(agentStates.values())
				.map(s => {
					const session = s.sessionFile ? "resumed" : "new";
					return `${displayName(s.def.name)} (${s.status}, ${session}, runs: ${s.runCount}): ${s.def.description}`;
				})
				.join("\n");
			safeNotify(_ctx, names || "No agents loaded", "info");
		},
	});

	pi.registerCommand("agents-grid", {
		description: "Set grid columns: /agents-grid <1-6>",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = ["1", "2", "3", "4", "5", "6"].map(n => ({
				value: n,
				label: `${n} columns`,
			}));
			const filtered = items.filter(i => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : items;
		},
		handler: async (args, _ctx) => {
			widgetCtx = _ctx;
			const n = parseInt(args?.trim() || "", 10);
			if (n >= 1 && n <= 6) {
				gridCols = n;
				safeNotify(_ctx, `Grid set to ${gridCols} columns`, "info");
				updateWidget();
			} else {
				safeNotify(_ctx, "Usage: /agents-grid <1-6>", "error");
			}
		},
	});

	pi.registerCommand("agents-clear", {
		description: "Clear agent team widget from screen",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;
			safeSetWidget(ctx, "agent-team", undefined);

			// Remove all individual agent widgets
			removeAllAgentWidgets();

			// Reset all agent states to idle so the widget can reappear on next dispatch
			for (const state of agentStates.values()) {
				if (state.status === "done" || state.status === "error") {
					state.status = "idle";
					state.task = "";
					state.toolCount = 0;
					state.elapsed = 0;
					state.lastWork = "";
					state.contextPct = 0;
					state.resolvedModel = "";
					state.textChunks = [];
					state.summary = undefined;
				}
			}
			selectedAgentIndex = -1;

			safeNotify(ctx, "Agent team widget cleared.", "info");
		},
	});

	// ── Agent Detail Overlay ──────────────────────

	class AgentDetailOverlay {
		private scrollOffset = 0;
		private totalContentLines = 0;

		constructor(
			private agent: AgentState,
			private onDone: () => void,
		) {}

		handleInput(data: string, tui: any): void {
			// Calculate max scroll based on current content
			const height = process.stdout.rows || 24;
			const contentHeight = height - 1; // Reserve 1 line for footer
			const maxScroll = Math.max(0, this.totalContentLines - contentHeight);

			if (matchesKey(data, Key.up)) {
				this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			} else if (matchesKey(data, Key.down)) {
				this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
			} else if (matchesKey(data, Key.pageUp)) {
				this.scrollOffset = Math.max(0, this.scrollOffset - Math.max(1, contentHeight - 1));
			} else if (matchesKey(data, Key.pageDown)) {
				this.scrollOffset = Math.min(maxScroll, this.scrollOffset + Math.max(1, contentHeight - 1));
			} else if (matchesKey(data, Key.home)) {
				this.scrollOffset = 0;
			} else if (matchesKey(data, Key.end)) {
				this.scrollOffset = maxScroll;
			} else if (matchesKey(data, Key.escape)) {
				this.onDone();
				return;
			}
			tui.requestRender();
		}

		render(width: number, height: number, theme: any): string[] {
			const container = new Container();
			const mdTheme = getPiMdTheme();

			// Full width with minimal padding
			const panelW = width - 4; // 2 chars padding each side
			const innerWidth = panelW - 2; // Account for border

			// Header with agent name pill and status
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			const name = displayName(this.agent.def.name);
			const statusBtn = statusButton(this.agent.status, name, theme, false);
			const timeStr = this.agent.status !== "idle" ? ` ${Math.round(this.agent.elapsed / 1000)}s` : "";
			container.addChild(new Text(
				`${statusBtn}${timeStr}`,
				1, 0,
			));
			container.addChild(new Spacer(1));

			// Section header helper - fills width with line characters
			const sectionHeader = (title: string) => {
				const label = ` ─── ${title} `;
				const remaining = Math.max(0, innerWidth - visibleWidth(label));
				return theme.fg("accent", theme.bold(label + "─".repeat(remaining)));
			};

			// Metadata section (full width, vertical list)
			container.addChild(new Text(sectionHeader("METADATA"), 1, 0));
			const formatRow = (label: string, value: string, valueColor: string = "muted") => {
				const labelStr = theme.fg("accent", theme.bold(padRight(label + ":", 14)));
				const valueStr = theme.fg(valueColor, value);
				return labelStr + " " + valueStr;
			};

			// Helper to add wrapped metadata rows
			const addWrappedRow = (label: string, value: string, valueColor: string = "muted") => {
				const labelWidth = 14;
				const valueWidth = innerWidth - labelWidth - 1;
				const wrapped = wordWrap(value, valueWidth);
				for (let i = 0; i < wrapped.length; i++) {
					const displayLabel = i === 0 ? label : "";
					container.addChild(new Text(formatRow(displayLabel, wrapped[i], valueColor), 1, 0));
				}
			};

			// STATUS - color based on state
			const statusColorMap: Record<string, string> = { running: "accent", done: "success", error: "error", idle: "dim" };
			const statusColor = statusColorMap[this.agent.status] || "muted";
			container.addChild(new Text(formatRow("STATUS", this.agent.status.toUpperCase(), statusColor), 1, 0));

			// DESCRIPTION - if present
			if (this.agent.def.description) {
				addWrappedRow("DESCRIPTION", this.agent.def.description, "muted");
			}

			// MODEL - accent color
			addWrappedRow("MODEL", this.agent.resolvedModel || this.agent.def.model || "(unknown)", "accent");

			// TOOLS - success color
			addWrappedRow("TOOLS", this.agent.def.tools, "success");

			// CONTEXT - conditional color based on percentage
			const pct = Math.ceil(this.agent.contextPct);
			const ctxColor = pct > 80 ? "error" : pct > 50 ? "warning" : "success";
			container.addChild(new Text(formatRow("CONTEXT", `${pct}%`, ctxColor), 1, 0));

			// RUNS - accent color
			container.addChild(new Text(formatRow("RUNS", this.agent.runCount.toString(), "accent"), 1, 0));

			// TOOLS USED - accent color
			container.addChild(new Text(formatRow("TOOLS USED", this.agent.toolCount.toString(), "accent"), 1, 0));

			// FILE - dim color (path)
			addWrappedRow("FILE", this.agent.def.file, "dim");

			// SESSION - dim color (path)
			if (this.agent.sessionFile) {
				addWrappedRow("SESSION", this.agent.sessionFile, "dim");
			}
			container.addChild(new Spacer(1));

			// System prompt section (full width)
			container.addChild(new Text(sectionHeader("SYSTEM PROMPT"), 1, 0));
			container.addChild(new Spacer(1));
			// Render system prompt as markdown - it will handle its own wrapping
			const sysPromptMd = new Markdown(this.agent.def.systemPrompt, 1, 0, mdTheme);
			container.addChild(sysPromptMd);
			container.addChild(new Spacer(1));

			// Task section (if present) - render as markdown
			if (this.agent.task) {
				container.addChild(new Text(sectionHeader("CURRENT TASK"), 1, 0));
				container.addChild(new Spacer(1));
				const taskMd = new Markdown(this.agent.task, 1, 0, mdTheme);
				container.addChild(taskMd);
				container.addChild(new Spacer(1));
			}

			// Last work section (if present) - render as markdown
			if (this.agent.lastWork) {
				container.addChild(new Text(sectionHeader("LAST WORK"), 1, 0));
				container.addChild(new Spacer(1));
				const workMd = new Markdown(this.agent.lastWork, 1, 0, mdTheme);
				container.addChild(workMd);
				container.addChild(new Spacer(1));
			}

			// Render all content (without footer)
			const allLines = container.render(panelW);
			this.totalContentLines = allLines.length; // Store for handleInput
			const contentHeight = height - 1; // Reserve 1 line for footer
			const maxScroll = Math.max(0, allLines.length - contentHeight);
			
			// Clamp scroll offset to valid range
			this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

			// Apply scrolling - show content lines, footer always at bottom
			const visibleContentLines = allLines.slice(this.scrollOffset, this.scrollOffset + contentHeight);

			// Footer (always visible at bottom, separate from scrollable content)
			const scrollInfo = maxScroll > 0 
				? ` ↑/↓/PgUp/PgDn/Home/End Scroll (${this.scrollOffset + 1}-${Math.min(this.scrollOffset + contentHeight, allLines.length)}/${allLines.length}) • Esc Close`
				: " Esc Close";
			const footer = theme.fg("dim", scrollInfo);
			const footerLine = padRight(footer, panelW);

			// Dark backdrop: full screen from top to bottom
			const dimBg = "\x1b[48;2;10;10;15m";
			const reset = "\x1b[0m";

			const result: string[] = [];
			// Render visible content lines from top
			// Pad each line to panelW before wrapping with background to ensure full coverage
			for (const line of visibleContentLines) {
				result.push(dimBg + "  " + padRight(line, panelW) + "  " + reset);
			}

			// Add footer at bottom (already padded to panelW)
			result.push(dimBg + "  " + footerLine + "  " + reset);

			// Fill remaining height with dark background
			while (result.length < height) {
				result.push(dimBg + " ".repeat(width) + reset);
			}

			return result;
		}
	}

	async function showAgentDetail(ctx: any, agent: AgentState) {
		await ctx.ui.custom((tui, theme, _kb, done) => {
			const overlay = new AgentDetailOverlay(agent, () => done(undefined));
			return {
				render: (w) => overlay.render(w, process.stdout.rows || 24, theme),
				handleInput: (data) => overlay.handleInput(data, tui),
				invalidate: () => {},
			};
		}, {
			overlay: true,
			overlayOptions: { width: "100%" },
		});
	}

	pi.registerShortcut("alt+g", {
		description: "Toggle agent team compact/expanded view",
		handler: async (ctx) => {
			widgetCtx = ctx;
			widgetCompact = !widgetCompact;
			updateWidget();
		},
	});

	const selectNext = async (ctx: any) => {
		if (!ctx.hasUI) return;
		widgetCtx = ctx;
		// Filter out only idle agents - include completed ones
		const active = Array.from(agentStates.values()).filter(
			(a) => a.status !== "idle",
		);
		const count = active.length;
		if (count === 0) {
			selectedAgentIndex = -1;
			return;
		}
		// Auto-expand to expanded view if in compact mode so selection is visible
		if (widgetCompact) {
			widgetCompact = false;
		}
		if (selectedAgentIndex < 0) selectedAgentIndex = 0;
		selectedAgentIndex = (selectedAgentIndex + 1) % count;
		updateWidget();
	};

	const selectPrev = async (ctx: any) => {
		if (!ctx.hasUI) return;
		widgetCtx = ctx;
		// Filter out only idle agents - include completed ones
		const active = Array.from(agentStates.values()).filter(
			(a) => a.status !== "idle",
		);
		const count = active.length;
		if (count === 0) {
			selectedAgentIndex = -1;
			return;
		}
		// Auto-expand to expanded view if in compact mode so selection is visible
		if (widgetCompact) {
			widgetCompact = false;
		}
		if (selectedAgentIndex < 0) selectedAgentIndex = count - 1;
		selectedAgentIndex = (selectedAgentIndex - 1 + count) % count;
		updateWidget();
	};

	const exitSelection = async (ctx: any) => {
		if (!ctx.hasUI) return;
		widgetCtx = ctx;
		selectedAgentIndex = -1;
		updateWidget();
	};

	// ── System Prompt Override ───────────────────

	pi.on("before_agent_start", async (_event, _ctx) => {
		// TEAM is an explicit orchestration mode. Never inject its prompt when the
		// mode bus has not selected TEAM; NORMAL owns the default prompt.
		const mode = coordinationState().mode;
		if (!modePromptMatches(mode, "TEAM")) return {};

		const agentCatalog = Array.from(agentStates.values())
			.map(s => `### ${displayName(s.def.name)}\n**Dispatch as:** \`${s.def.name}\`\n${s.def.description}\n**Tools:** ${s.def.tools}` + (s.def.model ? `\n**Model:** ${s.def.model}` : ""))
			.join("\n\n");
		const teamMembers = Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ");
		const scoutSection = agentStates.has("scout") ? `

## Context gathering
When the task involves unfamiliar code, multiple files, a call chain, or existing patterns, dispatch the scout first for bounded, read-only reconnaissance before sending work to builders or reviewers. For a small task with known files and symbols, you may dispatch the appropriate specialist directly. Do not inspect the codebase yourself.
Example: \`dispatch_agent { agent: "scout", task: "Map the relevant files and report paths, symbols, and risks." }\`` : `

## Context gathering
No scout is active. Use dispatch_agent with the listed specialist whose tools fit the investigation.`;

		return {
			systemPrompt: `You are the coordinator for TEAM mode.

${ORCHESTRATED_TASK_PROMPT}

${RESEARCH_ROUTING_PROMPT}

## Tool boundary
You do not use read, grep, find, ls, write, edit, or bash in TEAM mode. Delegate all codebase inspection, changes, and tests through dispatch_agent. You may synthesize results, answer the user, ask questions, plan work, and manage tasks.

${GRILL_ME_SECTION}

## Active Team
Members: ${teamMembers}
You can dispatch only to the agents listed below.
${scoutSection}

## Dispatch rules
- Keep each dispatch focused on one outcome.
- When two or more tasks have independent owners and do not need each other's
  intermediate result, use \`dispatch_team_batch\` to run them concurrently in
  one bounded call. Keep dependent work sequential with \`dispatch_agent\`.
- Use Builder agents for changes and Reviewer agents for verification/testing; the
  current TEAM roster has no separate Tester role.
- Do not dispatch merely to add ceremony.
- After a specialist returns ## RESULT, toggle that task to done before stopping.
- Report the result and next decision to the user.

## Completion
- Worker ## RESULT verification lines are untrusted claims.
- When team work is complete, present the outcome with show_report. If a ## Contract with executable assertions is bound (approved plan/spec), completion is blocked until those assertions PASS deterministically.

## Agents
${agentCatalog}`,
		};
	});

	// ── Reset helpers ─────────────────────────────────────────────────

	function resetAgentState(state: AgentState) {
		state.status = "idle";
		state.task = "";
		state.toolCount = 0;
		state.elapsed = 0;
		state.lastWork = "";
		state.contextPct = 0;
		state.resolvedModel = "";
		state.textChunks = [];
		state.summary = undefined;
	}

	function clearAgentTimer(state: AgentState) {
		if (!state.timer) return;
		lifecycle.clearTimer(state.timer);
		state.timer = undefined;
	}

	// ── Reset agent boxes on new message ───────────────────────────────

	pi.on("input", () => {
		// When user sends a new message, reset completed/error agents to idle
		// and remove their individual widgets so boxes display cleanly for the new task
		for (const state of agentStates.values()) {
			if (state.status === "done" || state.status === "error") {
				removeAgentWidget(state);
				resetAgentState(state);
			}
		}
		updateWidget();
	});

	// ── Clear session-bound UI references before replacement/reload ───────────

	pi.on("session_shutdown", async (_event, _ctx) => {
		lifecycle.stopAll();
		if ((globalThis as any).__piRefreshTaskWidget) {
			(globalThis as any).__piRefreshTaskWidget = undefined;
		}
		taskListWidget = undefined;
		taskListTui = undefined;
		sessionEpoch++;
		for (const state of agentStates.values()) {
			clearAgentTimer(state);
		}
		safeSetWidget(_ctx, "agent-team", undefined);
		removeAllAgentWidgets(_ctx);
		widgetCtx = undefined;
	});

	// ── Reset agent boxes on /new ─────────────────────────────────────

	pi.on("session_switch", async (_event, _ctx) => withSessionLifecycle(async () => {
		// /new fires session_switch — bind the replacement ctx before touching UI.
		sessionEpoch++;
		widgetCtx = _ctx;
		safeSetWidget(_ctx, "agent-team", undefined);
		removeAllAgentWidgets(_ctx);
		taskListWidget = undefined;
		taskListTui = undefined;
		taskListState = { selectedIndex: -1, scrollOffset: 0 };
		for (const state of agentStates.values()) {
			clearAgentTimer(state);
			resetAgentState(state);
		}
		(globalThis as any).__piRefreshTaskWidget = (ctx?: any) => updateWidget(ctx || widgetCtx);
		updateWidget(_ctx);
	}));

	// ── Session Start ────────────────────────────

	pi.on("session_start", async (_event, _ctx) => withSessionLifecycle(async () => {
		sessionEpoch++;
		applyExtensionDefaults(import.meta.url, _ctx);
		// Clear widgets using the current session ctx only.
		widgetCtx = _ctx;
		safeSetWidget(_ctx, "agent-team", undefined);
		removeAllAgentWidgets(_ctx);
		unwatchMode?.();
		unwatchMode = onCoordinationModeChange((mode, _previous, ctx) => {
			if (ctx?.ui) widgetCtx = ctx as typeof widgetCtx;
			if (!widgetCtx) return;
			if (mode !== "TEAM") {
				sessionEpoch++;
				lifecycle.stopAll();
				for (const state of agentStates.values()) {
					clearAgentTimer(state);
					if (state.status === "running" && state.proc) {
						try { state.proc.kill("SIGTERM"); } catch {}
					}
				}
				removeAllAgentWidgets(widgetCtx);
			}
		});
		contextWindow = _ctx.model?.contextWindow || 0;

		// Wipe old agent session files so subagents start fresh
		const sessDir = join(_ctx.cwd, ".pi", "agent-sessions");
		if (existsSync(sessDir)) {
			for (const f of readdirSync(sessDir)) {
				if (f.endsWith(".json")) {
					try { unlinkSync(join(sessDir, f)); } catch {}
				}
			}
		}

		loadAgents(_ctx.cwd);

		const preferred = defaultTeamName(teams);
		if (preferred) {
			activateTeam(preferred);
		}

		// All tools remain visible — dispatcher can use any registered tool directly

		safeSetStatus(_ctx, "agent-team", `Team: ${activeTeamName} (${agentStates.size})`);
		updateWidget(_ctx);

		// ── Expose global hooks for escape-cancel integration ────────────
		// Team agents also have running subprocesses that should be killed
		// on double-ESC. We reuse __piKillAllSubagents-style hook naming but
		// scoped to team procs. The escape-cancel extension checks these.
		(globalThis as any).__piKillTeamProcs = (): number => {
			let killed = 0;
			for (const [, state] of agentStates) {
				if (state.proc && state.status === "running") {
					try { state.proc.kill("SIGTERM"); } catch {}
					killed++;
				}
			}
			return killed;
		};
		(globalThis as any).__piHasRunningTeam = (): boolean => {
			for (const [, state] of agentStates) {
				if (state.status === "running") return true;
			}
			return false;
		};

		// Use footer.ts for footer — do not overwrite; widget uses placement: belowEditor

		// tasks.ts publishes state globally; this callback lets it refresh the
		// visible task widget immediately after add/toggle/new-list/clear.
		(globalThis as any).__piRefreshTaskWidget = (ctx?: any) => updateWidget(ctx || widgetCtx);

		// Register nav providers for F-key navigation
		const providers = ((globalThis as any).__piNavProviders = (globalThis as any).__piNavProviders || []);

		// Task list nav provider (first priority when tasks exist)
		providers.push({
			isActive: () => {
				const tl = (globalThis as any).__piTaskList as TaskListInfo | null;
				return !!(tl && tl.tasks.length > 0);
			},
			selectPrev: (ctx: any) => {
				if (!ctx.hasUI) return;
				widgetCtx = ctx;
				const tl = (globalThis as any).__piTaskList as TaskListInfo | null;
				if (!tl || tl.tasks.length === 0) return;
				if (taskListState.selectedIndex < 0) {
					taskListState = navEnter(taskListState, tl.tasks.length);
				} else {
					taskListState = navUp(taskListState);
				}
				updateWidget();
			},
			selectNext: (ctx: any) => {
				if (!ctx.hasUI) return;
				widgetCtx = ctx;
				const tl = (globalThis as any).__piTaskList as TaskListInfo | null;
				if (!tl || tl.tasks.length === 0) return;
				if (taskListState.selectedIndex < 0) {
					taskListState = navEnter(taskListState, tl.tasks.length);
				} else {
					taskListState = navDown(taskListState, tl.tasks.length);
				}
				updateWidget();
			},
			showDetail: async (_ctx: any) => {
				// Could open /tasks overlay in the future
			},
			exitSelection: (ctx: any) => {
				if (!ctx.hasUI) return;
				widgetCtx = ctx;
				taskListState = navExit(taskListState);
				updateWidget();
			},
		});

		// Agent pills nav provider
		providers.push({
			isActive: () => {
				const active = Array.from(agentStates.values()).filter(a => a.status !== "idle");
				return active.length > 0;
			},
			selectPrev: selectPrev,
			selectNext: selectNext,
			showDetail: async (ctx: any) => {
				if (!ctx.hasUI) return;
				const active = Array.from(agentStates.values()).filter(
					(a) => a.status !== "idle",
				);
				const count = active.length;
				if (count === 0 || selectedAgentIndex < 0 || selectedAgentIndex >= count) return;
				const agent = active[selectedAgentIndex];
				if (!agent) return;
				await showAgentDetail(ctx, agent);
			},
			exitSelection: exitSelection,
		});
	}));
}
