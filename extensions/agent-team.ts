// ABOUTME: Multi-agent team dispatcher with specialist agents and grid dashboard.
// ABOUTME: Primary agent delegates via subagent_create tool; teams defined in .pi/agents/teams.yaml.
/**
 * Agent Team — Dispatcher-only orchestrator with grid dashboard
 *
 * The primary Pi agent has NO codebase tools. It can ONLY delegate work
 * to specialist agents via the `subagent_create` tool. Each specialist
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

import {ExtensionAPI, ExtensionContext} from "@mariozechner/pi-coding-agent";
import { registerToolWithExecutor } from "./lib/tool-executor-registry.ts";
import { Type } from "@sinclair/typebox";
import { getMarkdownTheme as getPiMdTheme } from "@mariozechner/pi-coding-agent";
import { Text, type AutocompleteItem, truncateToWidth, Container, Spacer, Box, Markdown, matchesKey, Key } from "@mariozechner/pi-tui";
import { readdirSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { applyExtensionDefaults } from "./lib/themeMap.ts";
import { modePromptMatches } from "./lib/mode-cycler-logic.ts";
import { GRILL_ME_SECTION, ORCHESTRATED_TASK_PROMPT, RESEARCH_ROUTING_COMPACT_PROMPT } from "./lib/mode-prompts.ts";
import { coordinationState, onCoordinationModeChange } from "./lib/coordination-state.ts";

import { statusButton } from "./lib/pipeline-render.ts";
import { loadAgentModelsConfig, loadToolkitModelsConfig, parseAgentMdFile, scanToolkitAgentDefs, type AgentModelsConfig } from "./lib/agent-defs.ts";
import { padRight, wordWrap, displayName } from "./lib/ui-helpers.ts";
import { beginPanel, formatRow, sectionHeader } from "./lib/tui/panel.ts";
import { journalList, pruneRunArtifacts, reconcileJournal, registerTaskStatusCommand, type TaskJournalEntry } from "./lib/agent-task-journal.ts";
import { registerHerdrCommands } from "./lib/herdr-client.ts";
import { withSessionLifecycle } from "./lib/dispatch-runtime.ts";

import { matchNamedOption } from "./lib/named-pick.ts";
import { renderTaskList, navDown, navUp, navExit, navEnter, revealIncompleteTasks, type TaskListInfo, type TaskListState } from "./lib/task-list-render.ts";
import { renderSubagentWidget } from "./lib/subagent-render.ts";
import { createWorkerLifecycle } from "./lib/worker-lifecycle.ts";
import { projectTeamBatchRecovery } from "./lib/team-batch-recovery.ts";
import { resumableTeamSessionNames } from "./lib/team-session-cleanup.ts";
import { registerWorkflowDispatchHook } from "./lib/workflow-dispatch.ts";

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

// ── Agent Directory Scan ─────────────────────────

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
      const def = parseAgentMdFile(fullPath, modelsConfig, { includeFile: true });
      if (def && !seen.has(def.name.toLowerCase())) {
       seen.add(def.name.toLowerCase());
       agents.push(def);
      }
     }
    }
   };
   scan(dir);
  } catch { }
 }

 return agents;
}

// ── Extension ────────────────────────────────────

export default function(pi: ExtensionAPI) {
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
 const rosterAgents = new Set<string>();
 registerWorkflowDispatchHook("TEAM", {
  context: ({ name, task }) => {
   const state = ensureDispatchState(name);
   if (!state) return undefined;
   state.status = "running";
   state.task = task;
   state.toolCount = 0;
   state.elapsed = 0;
   state.lastWork = "";
   state.textChunks = [];
   state.summary = undefined;
   state.summaryLines = undefined;
   state.runCount++;
   registerAgentWidget(state);
   updateWidget();
   return undefined;
  },
  after: (result) => {
   const key = result.name.trim().toLowerCase().replace(/[\s_-]+/g, "-");
   const state = agentStates.get(key);
   if (!state) return;
   state.status = result.status;
   state.task = result.task;
   state.lastWork = result.output.slice(0, 500);
   state.summary = result.output.split("\n").find(Boolean)?.slice(0, 160) || "";
   invalidateAgentWidget(state);
   updateWidget();
  },
 });

 const TEAM_COORDINATOR_BLOCKED_TOOLS: Record<string, true> = {
  read: true, grep: true, ffgrep: true, find: true, ls: true, glob: true, bash: true,
  write: true, edit: true, write_file: true, edit_file: true, call_tool: true,
  eval_run: true, compose_exec: true, debug_capture: true, powershell: true,
 };
 pi.on("tool_call", async (event) => {
  if (coordinationState().mode !== "TEAM" || process.env.PI_SUBAGENT === "1") return { block: false };
  if (TEAM_COORDINATOR_BLOCKED_TOOLS[event.toolName] !== true) return { block: false };
  return {
   block: true,
   reason: `TEAM coordinator cannot call ${event.toolName} directly. Delegate codebase inspection, changes, and tests through subagent_create or subagent_create_batch.`,
  };
 });

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
  done: "\x1b[48;2;35;50;55m",    // dark teal-gray
  error: "\x1b[48;2;70;35;35m",    // dark muted red
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
    try { state.proc.kill("SIGTERM"); } catch { }
   }
  }
  agentStates.clear();
  rosterAgents.clear();
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
   rosterAgents.add(def.name.toLowerCase());
  }

  // Auto-size grid columns based on team size
  const size = agentStates.size;
  gridCols = size <= 3 ? size : size === 4 ? 2 : 3;
 }

 function ensureDispatchState(name: string): AgentState | undefined {
  const key = name.trim().toLowerCase();
  const existing = agentStates.get(key);
  if (existing) return existing;
  const def = allAgentDefs.find((candidate) => candidate.name.toLowerCase() === key);
  if (!def) return undefined;
  const sessionKey = key.replace(/\s+/g, "-");
  const state: AgentState = {
   def,
   status: "idle",
   task: "",
   toolCount: 0,
   elapsed: 0,
   lastWork: "",
   contextPct: 0,
   sessionFile: existsSync(join(sessionDir, `${sessionKey}.json`)) ? join(sessionDir, `${sessionKey}.json`) : null,
   runCount: 0,
   resolvedModel: "",
   widgetId: nextWidgetId++,
   textChunks: [],
   summary: undefined,
   summaryLines: undefined,
  };
  agentStates.set(key, state);
  gridCols = agentStates.size <= 3 ? agentStates.size : agentStates.size === 4 ? 2 : 3;
  return state;
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
     // Box(1, 1) gives Text two fewer columns than the outer widget.
     const result = renderSubagentWidget(renderState, Math.max(1, width - 2), theme);
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

 registerToolWithExecutor(pi, {
  name: "team_batch_recover",
  label: "Recover Team Batch",
  description: "Inspect a stale TEAM batch and return bounded worker resume candidates. Read-only; use subagent_resume after re-checking the workspace.",
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
    ...candidates.map((candidate) => `${candidate.status.padEnd(10)} ${candidate.agent} ${candidate.id}${candidate.canResume ? " resumable — subagent_resume after workspace re-check" : " inspect/re-dispatch required"} task=${candidate.task.replace(/\s+/g, " ")}`),
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

 // ── Agent Detail Overlay ──────────────────────

 class AgentDetailOverlay {
  private scrollOffset = 0;
  private totalContentLines = 0;

  constructor(
   private agent: AgentState,
   private onDone: () => void,
  ) { }

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
   beginPanel(theme, container);
   const name = displayName(this.agent.def.name);
   const statusBtn = statusButton(this.agent.status, name, theme, false);
   const timeStr = this.agent.status !== "idle" ? ` ${Math.round(this.agent.elapsed / 1000)}s` : "";
   container.addChild(new Text(
    `${statusBtn}${timeStr}`,
    1, 0,
   ));
   container.addChild(new Spacer(1));

   // Metadata section (full width, vertical list)
   container.addChild(sectionHeader(theme, "METADATA", innerWidth));

   // Helper to add wrapped metadata rows
   const addWrappedRow = (label: string, value: string, valueColor: string = "muted") => {
    const labelWidth = 14;
    const valueWidth = innerWidth - labelWidth - 1;
    const wrapped = wordWrap(value, valueWidth);
    for (let i = 0; i < wrapped.length; i++) {
     const displayLabel = i === 0 ? label : "";
     container.addChild(formatRow(theme, displayLabel, wrapped[i], valueColor, 14));
    }
   };

   // STATUS - color based on state
   const statusColorMap: Record<string, string> = { running: "accent", done: "success", error: "error", idle: "dim" };
   const statusColor = statusColorMap[this.agent.status] || "muted";
   container.addChild(formatRow(theme, "STATUS", this.agent.status.toUpperCase(), statusColor, 14));

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
   container.addChild(formatRow(theme, "CONTEXT", `${pct}%`, ctxColor, 14));

   // RUNS - accent color
   container.addChild(formatRow(theme, "RUNS", this.agent.runCount.toString(), "accent", 14));

   // TOOLS USED - accent color
   container.addChild(formatRow(theme, "TOOLS USED", this.agent.toolCount.toString(), "accent", 14));

   // FILE - dim color (path)
   addWrappedRow("FILE", this.agent.def.file, "dim");

   // SESSION - dim color (path)
   if (this.agent.sessionFile) {
    addWrappedRow("SESSION", this.agent.sessionFile, "dim");
   }
   container.addChild(new Spacer(1));

   // System prompt section (full width)
   container.addChild(sectionHeader(theme, "SYSTEM PROMPT", innerWidth));
   container.addChild(new Spacer(1));
   // Render system prompt as markdown - it will handle its own wrapping
   const sysPromptMd = new Markdown(this.agent.def.systemPrompt, 1, 0, mdTheme);
   container.addChild(sysPromptMd);
   container.addChild(new Spacer(1));

   // Task section (if present) - render as markdown
   if (this.agent.task) {
    container.addChild(sectionHeader(theme, "CURRENT TASK", innerWidth));
    container.addChild(new Spacer(1));
    const taskMd = new Markdown(this.agent.task, 1, 0, mdTheme);
    container.addChild(taskMd);
    container.addChild(new Spacer(1));
   }

   // Last work section (if present) - render as markdown
   if (this.agent.lastWork) {
    container.addChild(sectionHeader(theme, "LAST WORK", innerWidth));
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

 async function showAgentDetail(ctx: ExtensionContext, agent: AgentState) {
  await ctx.ui.custom((tui, theme, _kb, done) => {
   const overlay = new AgentDetailOverlay(agent, () => done(undefined));
   return {
    render: (w) => overlay.render(w, process.stdout.rows || 24, theme),
    handleInput: (data) => overlay.handleInput(data, tui),
    invalidate: () => { },
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
  const rosterNames = new Set(Array.from(agentStates.values()).map(s => s.def.name.toLowerCase()));
  const otherAgentNames = allAgentDefs
   .map(s => s.name)
   .filter(name => !rosterNames.has(name.toLowerCase()))
   .sort();
  const scoutSection = agentStates.has("scout") ? `

## Context gathering
When material context is unfamiliar — multiple files, a call chain, or missing patterns — dispatch one scout for bounded, read-only reconnaissance before sending work to builders or reviewers. For a small task with known files and symbols, or a verified terminal result, dispatch the appropriate specialist directly. Do not inspect the codebase yourself.
Example: \`subagent_create { name: "scout", task: "Map the relevant files and report paths, symbols, and risks." }\`` : `

## Context gathering
No scout is active. Use subagent_create with the listed specialist whose tools fit the investigation.`;

  return {
   systemPrompt: `You are the coordinator for TEAM mode.

${ORCHESTRATED_TASK_PROMPT}

${RESEARCH_ROUTING_COMPACT_PROMPT}

## Tool boundary
You do not use read, grep, find, ls, write, edit, or bash in TEAM mode. Delegate all codebase inspection, changes, and tests through subagent_create. You may synthesize results, answer the user, ask questions, plan work, and manage tasks.

${GRILL_ME_SECTION}

## Active Team
Members: ${teamMembers}
Roster members are the default team for this session. Dispatch is not restricted
to them: any loaded specialist may be dispatched by name —${otherAgentNames.length > 0 ? ` including ${otherAgentNames.join(", ")} —` : ""} whenever the task calls for it. The agent catalog below details the active roster; for any other specialist, dispatch it by exact name and state the outcome you need.
${scoutSection}

## Dispatch rules
- Keep each dispatch focused on one outcome.
- Before running ANY tool (including read-only recon or bash), toggle the first task to inprogress (\`tasks toggle <id>\`); keep the task you are working on inprogress at all times and toggle it done only after its specialist ## RESULT is in. The task gate blocks tools while nothing is inprogress (dogfood D19).
- When two or more tasks have independent owners and do not need each other's
  intermediate result, use \`subagent_create_batch\` to run them concurrently in
  one bounded call. Keep dependent work sequential with \`subagent_create\`.
- Use Builder agents for changes and Reviewer agents for verification/testing; dispatch a Tester specialist by name when the task needs it.
- Do not dispatch merely to add ceremony.
- After a specialist returns ## RESULT, toggle that task to done before stopping.
- Report the result and next decision to the user.

## Completion
- Worker ## RESULT verification lines are untrusted claims.
- When all joined or waited batch workers finish, the shared completion gate binds the non-empty task (or structured Objective), runs independent verification, dispatches bounded joined builder repair on FAIL, and admits success only after PASS. Empty tasks, FAIL, BLOCKED, cancellation, or repair failure never permit done:true. show_report remains gated; /report is observation-only.

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
  for (const [key, state] of agentStates) {
   if (!rosterAgents.has(key)) {
    removeAgentWidget(state);
    agentStates.delete(key);
   } else if (state.status === "done" || state.status === "error") {
    removeAgentWidget(state);
    resetAgentState(state);
   }
  }
  gridCols = agentStates.size <= 3 ? agentStates.size : agentStates.size === 4 ? 2 : 3;
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

 pi.on("session_before_switch", async (_event, _ctx) => withSessionLifecycle(async () => {
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
      try { state.proc.kill("SIGTERM"); } catch { }
     }
    }
    removeAllAgentWidgets(widgetCtx);
   }
  });
  contextWindow = _ctx.model?.contextWindow || 0;

  loadAgents(_ctx.cwd);

  // Clear only TEAM-owned role sessions. This directory is shared with
  // CHAIN/PIPELINE and their durable snapshots; deleting every JSON file
  // here would destroy recovery material owned by those modes.
  const sessDir = join(_ctx.cwd, ".pi", "agent-sessions");
  const teamSessionNames = new Set(allAgentDefs.map((def) => `${def.name.toLowerCase().replace(/\s+/g, "-")}.json`));
  const resumableTeamSessions = resumableTeamSessionNames(journalList(sessDir), sessDir, teamSessionNames);
  if (existsSync(sessDir)) {
   for (const f of readdirSync(sessDir)) {
    if (teamSessionNames.has(f) && !resumableTeamSessions.has(f)) {
     try { unlinkSync(join(sessDir, f)); } catch { }
    }
   }
  }

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
     try { state.proc.kill("SIGTERM"); } catch { }
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
