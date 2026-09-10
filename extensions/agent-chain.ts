// ABOUTME: Sequential role workflow driven by canonical subagent_create dispatch.
// ABOUTME: Each parent turn passes one bounded result to the next configured step.
/**
 * Agent Chain — Sequential pipeline orchestrator
 *
 * Runs opinionated, repeatable agent workflows. Chains are defined in
 * .pi/agents/agent-chain.yaml — each chain is a sequence of agent steps
 * with prompt templates. The user's original prompt flows into step 1,
 * the output becomes $INPUT for step 2's prompt template, and so on.
 * $ORIGINAL is always the user's original prompt.
 *
 * The primary Pi agent uses subagent_create for every step. Automatic chain
 * execution and snapshot resume are retired; select CHAIN through set_mode.
 *
 * Usage: pi -e extensions/agent-chain.ts
 */

import {ExtensionAPI, ExtensionContext} from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme as getPiMdTheme } from "@mariozechner/pi-coding-agent";
import { Text, visibleWidth, truncateToWidth, Container, Spacer, Markdown, matchesKey, Key } from "@mariozechner/pi-tui";
import { hideWidget, safeSetWidget } from "./lib/tui/widget.ts";
import { beginPanel, formatRow, sectionHeader } from "./lib/tui/panel.ts";
import { truncatePreview } from "./lib/tui/text.ts";
import { registerHerdrCommands } from "./lib/herdr-client.ts";
import { readFileSync, existsSync, readdirSync, mkdirSync, unlinkSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { applyExtensionDefaults } from "./lib/themeMap.ts";
import { modePromptMatches } from "./lib/mode-cycler-logic.ts";
import { GRILL_ME_SECTION, ORCHESTRATED_TASK_PROMPT, RESEARCH_ROUTING_COMPACT_PROMPT } from "./lib/mode-prompts.ts";
import { coordinationState, setActiveChain, onCoordinationModeChange } from "./lib/coordination-state.ts";
import { statusButton } from "./lib/pipeline-render.ts";
import { pruneRunArtifacts, reconcileJournal } from "./lib/agent-task-journal.ts";
import { readChainSnapshot, type ChainSnapshot } from "./lib/chain-state.ts";
import { loadExplicitAgentModelsConfig, parseAgentMdFile, type AgentModelsConfig } from "./lib/agent-defs.ts";
import { displayName } from "./lib/ui-helpers.ts";
import { providerModelString } from "./lib/model-inheritance.ts";
import { parseChainYaml, type ChainDef } from "./lib/parse-chain-yaml.ts";
import { withSessionLifecycle } from "./lib/dispatch-runtime.ts";
import { createWorkerLifecycle } from "./lib/worker-lifecycle.ts";
import { registerWorkflowDispatchHook } from "./lib/workflow-dispatch.ts";

// ── Types ────────────────────────────────────────

interface AgentDef {
 name: string;
 description: string;
 tools: string;
 model: string; // full provider/model ID, empty = use default
 systemPrompt: string;
}

interface StepState {
 agent: string;
 description: string;
 status: "pending" | "running" | "done" | "error";
 elapsed: number;
 lastWork: string;
 toolCount?: number;
}

// ── Agent Directory Scan ─────────────────────────

function scanAgentDirs(cwd: string, extProjectDir?: string, modelsConfig?: AgentModelsConfig): Map<string, AgentDef> {
 const dirs = [
  join(cwd, "agents"),
  join(cwd, ".claude", "agents"),
  join(cwd, ".pi", "agents"),
  ...(extProjectDir ? [join(extProjectDir, ".pi", "agents"), join(extProjectDir, "agents")] : []),
 ];

 const agents = new Map<string, AgentDef>();

 for (const dir of dirs) {
  if (!existsSync(dir)) continue;
  try {
   const scan = (d: string) => {
    for (const file of readdirSync(d, { withFileTypes: true })) {
     const fullPath = resolve(d, file.name);
     if (file.isDirectory()) {
      scan(fullPath);
     } else if (file.name.endsWith(".md")) {
      const def = parseAgentMdFile(fullPath, modelsConfig, { defaultFallback: true });
      if (def && !agents.has(def.name.toLowerCase())) {
       agents.set(def.name.toLowerCase(), def);
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
 let allAgents: Map<string, AgentDef> = new Map();
 let chains: ChainDef[] = [];
 let activeChain: ChainDef | null = null;
 let widgetCtx: any;
 let unwatchMode: (() => void) | undefined;
 let sessionDir = "";
 let launchModel = "";
 const agentSessions: Map<string, string | null> = new Map();

 // Per-step state for the active chain
 let stepStates: StepState[] = [];
 let pendingReset = false;
 let resumeAvailable: ChainSnapshot | undefined;
 let selectedStepIndex = -1;

 // Track the currently running chain subprocess for cancellation
 let currentChainProc: any = null;
 let currentChainTimer: ReturnType<typeof setInterval> | null = null;
 let navProvider: any = null;
 const lifecycle = createWorkerLifecycle();
 registerWorkflowDispatchHook("CHAIN", {
  before: ({ name }) => {
   if (!activeChain || stepStates.length === 0) return "CHAIN dispatch blocked: no active chain is selected.";
   const next = stepStates.findIndex((step) => step.status !== "done");
   if (next < 0) return "CHAIN dispatch blocked: all chain steps are already complete.";
   const normalize = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/g, "-");
   const expected = normalize(activeChain.steps[next]?.agent || "");
   return expected === normalize(name)
    ? undefined
    : `CHAIN dispatch blocked: step ${next + 1} must run ${activeChain.steps[next]?.agent}.`;
  },
  after: (result) => {
   if (!activeChain) return;
   const normalize = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/g, "-");
   const index = stepStates.findIndex((step) => normalize(step.agent) === normalize(result.name) && step.status !== "done");
   if (index < 0) return;
   stepStates[index].status = result.status === "done" ? "done" : "error";
   stepStates[index].lastWork = result.output.slice(0, 500);
   updateWidget();
  },
 });

 function loadChains(cwd: string) {
  const extDir = dirname(fileURLToPath(import.meta.url));
  const securityGuardExtPath = join(extDir, "security-guard.ts");
  const extProjectDir = resolve(extDir, "..");

  sessionDir = join(cwd, ".pi", "agent-sessions");
  if (!existsSync(sessionDir)) {
   mkdirSync(sessionDir, { recursive: true });
   pruneRunArtifacts(sessionDir); // 7-day rolling retention (archives + journal)
   reconcileJournal(sessionDir); // close rows orphaned by a crashed parent
  }

  // Only project/user routing is explicit. Do not let this package's bundled
  // cross-provider assignments silently override the launching Pi model.
  const modelsConfig = loadExplicitAgentModelsConfig(cwd);
  allAgents = scanAgentDirs(cwd, extProjectDir, modelsConfig);

  agentSessions.clear();
  for (const [key] of allAgents) {
   const sessionFile = join(sessionDir, `chain-${key}.json`);
   agentSessions.set(key, existsSync(sessionFile) ? sessionFile : null);
  }

  let chainPath = join(cwd, ".pi", "agents", "agent-chain.yaml");
  if (!existsSync(chainPath)) {
   chainPath = join(extProjectDir, ".pi", "agents", "agent-chain.yaml");
  }
  if (!existsSync(chainPath)) {
   chainPath = join(extProjectDir, "agents", "agent-chain.yaml");
  }
  if (existsSync(chainPath)) {
   try {
    chains = parseChainYaml(readFileSync(chainPath, "utf-8"));
   } catch {
    chains = [];
   }
  } else {
   chains = [];
  }
 }

 function activateChain(chain: ChainDef) {
  activeChain = chain;
  setActiveChain(chain.name);
  selectedStepIndex = -1;
  stepStates = chain.steps.map(s => {
   const agentDef = allAgents.get(s.agent.toLowerCase());
   return {
    agent: s.agent,
    description: agentDef?.description || "",
    status: "pending" as const,
    elapsed: 0,
    lastWork: "",
   };
  });
  // Skip widget re-registration if reset is pending — let before_agent_start handle it
  if (!pendingReset) {
   updateWidget();
  }
 }

 // ── Card Rendering ──────────────────────────

 function renderStepLines(state: StepState, index: number, width: number, theme: any): string[] {
  const name = displayName(state.agent);
  const statusForButton = state.status === "pending" ? "idle" : state.status;
  const btn = statusButton(statusForButton, name, theme);
  const timeStr = state.status !== "pending" && state.elapsed > 0
   ? "  " + theme.fg("dim", `${Math.round(state.elapsed / 1000)}s`)
   : "";
  const lines: string[] = [];
  let pillLine = ` ${btn}${timeStr}`;
  if (index === selectedStepIndex) {
   pillLine = ` ${theme.fg("accent", "[")}${btn}${theme.fg("accent", "]")}${timeStr}`;
  }
  lines.push(pillLine);
  if (state.lastWork && state.status !== "pending") {
   const prefix = " \u2502  ";
   const maxWork = width - prefix.length - 1;
   const work = truncatePreview(state.lastWork, maxWork);
   lines.push(theme.fg("dim", " \u2502") + "  " + theme.fg("muted", work));
  }
  if (state.status === "pending" && state.description) {
   const prefix = "    ";
   const maxDesc = width - prefix.length - 1;
   const desc = truncatePreview(state.description, maxDesc);
   lines.push("    " + theme.fg("dim", desc));
  }
  return lines;
 }

 function hideChainWidget(ctx?: ExtensionContext | { ui?: { setWidget: (key: string, renderer: unknown) => void } }) {
  hideWidget(ctx ?? widgetCtx, "agent-chain");
 }

 function updateWidget() {
  if (!widgetCtx) return;
  if (coordinationState().mode !== "CHAIN") {
   hideChainWidget();
   return;
  }
  // Only show widget when pipeline is actually running (at least one non-pending step)
  const hasActiveStep = stepStates.some(s => s.status !== "pending");
  if (!hasActiveStep) return;
  safeSetWidget(widgetCtx, "agent-chain", (_tui: any, theme: any) => {
   const text = new Text("", 0, 1);

   return {
    render(width: number): string[] {
     if (!activeChain || stepStates.length === 0) {
      text.setText(theme.fg("dim", "No chain active. Use set_mode with CHAIN after loading a chain config."));
      return text.render(width);
     }

     const outputLines: string[] = [];
     const chainName = activeChain.name;
     const rule = "─".repeat(Math.max(0, width - chainName.length - 6));
     outputLines.push(theme.fg("dim", ` ── `) + theme.fg("accent", chainName) + theme.fg("dim", ` ${rule}`));
     for (let i = 0; i < stepStates.length; i++) {
      outputLines.push(...renderStepLines(stepStates[i], i, width, theme));
      if (i < stepStates.length - 1) {
       outputLines.push(theme.fg("dim", " \u2502"));
      }
     }
     text.setText(outputLines.join("\n"));
     return text.render(width);
    },
    invalidate() {
     text.invalidate();
    },
   };
  });
 }

 // ── System Prompt Override ───────────────────

 pi.on("before_agent_start", async (_event, _ctx) => {
  widgetCtx = _ctx;
  // Force widget reset on first turn after /new
  if (pendingReset && activeChain) {
   pendingReset = false;
   stepStates = activeChain.steps.map(s => {
    const agentDef = allAgents.get(s.agent.toLowerCase());
    return {
     agent: s.agent,
     description: agentDef?.description || "",
     status: "pending" as const,
     elapsed: 0,
     lastWork: "",
    };
   });
   updateWidget();
  }

  // Mode gate: only the explicitly selected mode may inject this prompt
  const mode = coordinationState().mode;
  if (!modePromptMatches(mode, "CHAIN")) return {};

  if (!activeChain) return {};

  const flow = activeChain.steps.map(s => displayName(s.agent)).join(" → ");
  const desc = activeChain.description ? `\n${activeChain.description}` : "";

  // Build pipeline steps summary
  const steps = activeChain.steps.map((s, i) => {
   const agentDef = allAgents.get(s.agent.toLowerCase());
   const agentDesc = agentDef?.description || "";
   return `${i + 1}. **${displayName(s.agent)}** — ${agentDesc}`;
  }).join("\n");

  // Build full agent catalog (like agent-team.ts)
  const seen = new Set<string>();
  const agentCatalog = activeChain.steps
   .filter(s => {
    const key = s.agent.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
   })
   .map(s => {
    const agentDef = allAgents.get(s.agent.toLowerCase());
    if (!agentDef) return `### ${displayName(s.agent)}\nAgent not found.`;
    return `### ${displayName(agentDef.name)}\n${agentDef.description}\n**Tools:** ${agentDef.tools}`;
   })
   .join("\n\n");

  return {
   systemPrompt: `You are the coordinator for a sequential pipeline called "${activeChain.name}".${desc}

${ORCHESTRATED_TASK_PROMPT}

${RESEARCH_ROUTING_COMPACT_PROMPT}

Dispatch SCOUT only when the current chain step lacks local context needed for its handoff. Reuse an existing scoped SCOUT result; do not dispatch merely because the chain has entered a new step or because a path has already been verified absent.

			You orchestrate via \`subagent_create\`. Do not implement, test, or re-verify the chain's work yourself (no bash, python, write, or edit for that work). After the workers return, quote the step summaries from ## RESULT.

${GRILL_ME_SECTION}

## Active Chain: ${activeChain.name}
Flow: ${flow}

${steps}

## Agent Details

${agentCatalog}

## When to Use subagent_create
- Significant work: new features, refactors, multi-file changes, anything non-trivial
- Tasks that benefit from the full pipeline: planning, building, reviewing
- When you want structured, multi-agent collaboration on a problem

## When not to work directly
- Do not write files or run verification the chain already ran
- Quick questions to the user are fine; use NORMAL for trivial one-file edits
- Any leftover edit or execution still requires an active task

## How sequential subagent_create Works
- Pass a clear task description to subagent_create
- Each step's output feeds into the next step as $INPUT
- Agents maintain session context — they remember previous work within this session
- You can run the chain multiple times with different tasks if needed
- After the chain completes, report the RESULT summaries — do not re-run them`,
  };
 });

 // ── Step Detail Overlay ──────────────────────

 function padRight(s: string, width: number): string {
  const vis = visibleWidth(s);
  if (vis >= width) return truncateToWidth(s, width, "");
  return s + " ".repeat(width - vis);
 }

 function wordWrap(text: string, width: number): string[] {
  if (visibleWidth(text) <= width) return [text];
  const words = text.split(/(\s+)/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
   if (visibleWidth(cur + w) > width && cur.length > 0) {
    lines.push(cur);
    cur = w.trimStart();
   } else {
    cur += w;
   }
  }
  if (cur.length > 0) lines.push(cur);
  return lines;
 }

 class StepDetailOverlay {
  private scrollOffset = 0;
  private totalContentLines = 0;

  constructor(
   private step: StepState,
   private agentDef: AgentDef | null,
   private onDone: () => void,
  ) { }

  handleInput(data: string, tui: any): void {
   const height = process.stdout.rows || 24;
   const contentHeight = height - 1;
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
   const panelW = width - 4;
   const innerWidth = panelW - 2;

   // Header with step name pill and status
   beginPanel(theme, container);
   const name = displayName(this.step.agent);
   const statusForButton = this.step.status === "pending" ? "idle" : this.step.status;
   const statusBtn = statusButton(statusForButton, name, theme);
   const timeStr = this.step.status !== "pending" && this.step.elapsed > 0
    ? ` ${Math.round(this.step.elapsed / 1000)}s` : "";
   container.addChild(new Text(`${statusBtn}${timeStr}`, 1, 0));
   container.addChild(new Spacer(1));

   // Metadata section
   container.addChild(sectionHeader(theme, "METADATA", innerWidth));

   const addWrappedRow = (label: string, value: string, valueColor: string) => {
    const labelWidth = 14;
    const valueWidth = innerWidth - labelWidth - 1;
    const wrapped = wordWrap(value, valueWidth);
    for (let i = 0; i < wrapped.length; i++) {
     const displayLabel = i === 0 ? label : "";
     container.addChild(formatRow(theme, displayLabel, wrapped[i], valueColor, 14));
    }
   };

   const statusColorMap: Record<string, string> = { running: "accent", done: "success", error: "error", pending: "dim" };
   const statusColor = statusColorMap[this.step.status] || "muted";
   container.addChild(formatRow(theme, "STATUS", this.step.status.toUpperCase(), statusColor, 14));

   if (this.step.description) {
    addWrappedRow("DESCRIPTION", this.step.description, "muted");
   }

   if (this.agentDef?.tools) {
    addWrappedRow("TOOLS", this.agentDef.tools, "success");
   }

   container.addChild(new Spacer(1));

   // System prompt section
   if (this.agentDef?.systemPrompt) {
    container.addChild(sectionHeader(theme, "SYSTEM PROMPT", innerWidth));
    container.addChild(new Spacer(1));
    const sysPromptMd = new Markdown(this.agentDef.systemPrompt, 1, 0, mdTheme);
    container.addChild(sysPromptMd);
    container.addChild(new Spacer(1));
   }

   // Last work section
   if (this.step.lastWork) {
    container.addChild(sectionHeader(theme, "LAST WORK", innerWidth));
    container.addChild(new Spacer(1));
    const workMd = new Markdown(this.step.lastWork, 1, 0, mdTheme);
    container.addChild(workMd);
    container.addChild(new Spacer(1));
   }

   // Render all content
   const allLines = container.render(panelW);
   this.totalContentLines = allLines.length;
   const contentHeight = height - 1;
   const maxScroll = Math.max(0, allLines.length - contentHeight);
   this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
   const visibleContentLines = allLines.slice(this.scrollOffset, this.scrollOffset + contentHeight);

   const scrollInfo = maxScroll > 0
    ? ` \u2191/\u2193/PgUp/PgDn/Home/End Scroll (${this.scrollOffset + 1}-${Math.min(this.scrollOffset + contentHeight, allLines.length)}/${allLines.length}) \u2022 Esc Close`
    : " Esc Close";
   const footer = theme.fg("dim", scrollInfo);
   const footerLine = padRight(footer, panelW);

   const dimBg = "\x1b[48;2;10;10;15m";
   const reset = "\x1b[0m";

   const result: string[] = [];
   for (const line of visibleContentLines) {
    result.push(dimBg + "  " + padRight(line, panelW) + "  " + reset);
   }
   result.push(dimBg + "  " + footerLine + "  " + reset);
   while (result.length < height) {
    result.push(dimBg + " ".repeat(width) + reset);
   }

   return result;
  }
 }

 async function showStepDetail(ctx: any, step: StepState, agentDef: AgentDef | null) {
  await ctx.ui.custom((tui: any, theme: any, _kb: any, done: any) => {
   const overlay = new StepDetailOverlay(step, agentDef, () => done(undefined));
   return {
    render: (w: number) => overlay.render(w, process.stdout.rows || 24, theme),
    handleInput: (data: string) => overlay.handleInput(data, tui),
    invalidate: () => { },
   };
  }, {
   overlay: true,
   overlayOptions: { width: "100%" },
  });
 }

 // ── Session Start ───────────────────────────

 pi.on("session_start", async (_event, _ctx) => withSessionLifecycle(async () => {
  applyExtensionDefaults(import.meta.url, _ctx);
  launchModel = providerModelString(_ctx.model);
  // Clear widget with both old and new ctx — one of them will be valid
  if (widgetCtx) hideChainWidget(widgetCtx);
  hideChainWidget(_ctx);
  widgetCtx = _ctx;
  unwatchMode?.();
  unwatchMode = onCoordinationModeChange((mode, _previous, ctx) => {
   if (ctx?.ui) widgetCtx = ctx as typeof widgetCtx;
   if (mode !== "CHAIN") {
    // Leaving CHAIN is a cancellation boundary: do not keep hidden
    // workers running after the user selects another orchestration mode.
    lifecycle.stopAll();
    currentChainProc = null;
    currentChainTimer = null;
    hideChainWidget(ctx);
   }
   else updateWidget();
  });

  // Reset execution state — widget re-registration deferred to before_agent_start
  stepStates = [];
  activeChain = null;
  setActiveChain(null);
  selectedStepIndex = -1;
  pendingReset = true;

  const sessDir = join(_ctx.cwd, ".pi", "agent-sessions");
  const savedChain = readChainSnapshot(sessDir);
  resumeAvailable = savedChain;
  // A durable snapshot means an interrupted chain can be resumed; preserve
  // its worker sessions until the user explicitly starts a fresh chain.
  if (!savedChain && existsSync(sessDir)) {
   for (const f of readdirSync(sessDir)) {
    if (f.startsWith("chain-") && f.endsWith(".json")) {
     try { unlinkSync(join(sessDir, f)); } catch { }
    }
   }
  }

  // Reload chains + clear agentSessions map (all agents start fresh)
  loadChains(_ctx.cwd);

  if (chains.length === 0) {
   _ctx.ui.notify("No chains found in .pi/agents/agent-chain.yaml", "warning");
   return;
  }

  // Default to first chain. Canonical CHAIN has no automatic resume path.
  const savedChainDef = savedChain && chains.find(chain => chain.name === savedChain.chain && chain.steps.length === savedChain.steps.length);
  activateChain(chains[0]);
  if (savedChainDef) {
   _ctx.ui.notify(`Legacy interrupted chain ${savedChainDef.name} found; automatic resume is unavailable. Start a new canonical CHAIN run with subagent_create.`, "warning");
  }

  // ── Expose global hooks for escape-cancel integration ────────────
  (globalThis as any).__piKillChainProc = (): boolean => {
   if (currentChainProc) {
    try { currentChainProc.kill("SIGTERM"); } catch { }
    currentChainProc = null;
    return true;
   }
   return false;
  };
  (globalThis as any).__piHasRunningChain = (): boolean => {
   return currentChainProc !== null;
  };

  // Chain execution is retired; subagent_create is the sole worker entrypoint.

  _ctx.ui.setStatus("agent-chain", `Chain: ${activeChain!.name} (${activeChain!.steps.length} steps)`);
  // Footer: use footer.ts only — do not overwrite

  // Register nav provider for F-key navigation
  const providers = ((globalThis as any).__piNavProviders = (globalThis as any).__piNavProviders || []);
  if (navProvider) {
   const oldIndex = providers.indexOf(navProvider);
   if (oldIndex >= 0) providers.splice(oldIndex, 1);
  }
  navProvider = {
   isActive: () => activeChain !== null && stepStates.length > 0,
   selectPrev: (_ctx2: any) => {
    const count = stepStates.length;
    if (count === 0) { selectedStepIndex = -1; return; }
    if (selectedStepIndex < 0) selectedStepIndex = count - 1;
    else selectedStepIndex = (selectedStepIndex - 1 + count) % count;
    updateWidget();
   },
   selectNext: (_ctx2: any) => {
    const count = stepStates.length;
    if (count === 0) { selectedStepIndex = -1; return; }
    if (selectedStepIndex < 0) selectedStepIndex = 0;
    else selectedStepIndex = (selectedStepIndex + 1) % count;
    updateWidget();
   },
   showDetail: async (ctx: any) => {
    if (selectedStepIndex < 0 || selectedStepIndex >= stepStates.length) return;
    const step = stepStates[selectedStepIndex];
    const agentDef = allAgents.get(step.agent.toLowerCase()) || null;
    await showStepDetail(ctx, step, agentDef);
   },
   exitSelection: (_ctx2: any) => {
    selectedStepIndex = -1;
    updateWidget();
   },
  };
  providers.push(navProvider);
 }));

 pi.on("session_shutdown", async (_event, _ctx) => {
  lifecycle.stopAll();
  unwatchMode?.();
  unwatchMode = undefined;
  currentChainTimer = null;
  if (currentChainProc) {
   try { currentChainProc.kill("SIGTERM"); } catch { }
   currentChainProc = null;
  }
  const providers = (globalThis as any).__piNavProviders as any[] | undefined;
  if (providers && navProvider) {
   const index = providers.indexOf(navProvider);
   if (index >= 0) providers.splice(index, 1);
  }
  navProvider = null;
  (globalThis as any).__piKillChainProc = undefined;
  (globalThis as any).__piHasRunningChain = undefined;
  activeChain = null;
  stepStates = [];
  setActiveChain(null);
  hideChainWidget(_ctx);
  widgetCtx = undefined;
 });

 pi.on("session_before_switch", async (_event, ctx) => withSessionLifecycle(async () => {
  // /new is not guaranteed to emit session_shutdown. Stop every chain-owned
  // process/timer and invalidate callbacks before the replacement session
  // can issue another dispatch.
  lifecycle.stopAll();
  if (currentChainProc) {
   try { currentChainProc.kill("SIGTERM"); } catch { }
   currentChainProc = null;
  }
  currentChainTimer = null;
  unwatchMode?.();
  unwatchMode = undefined;
  stepStates = [];
  activeChain = null;
  setActiveChain(null);
  selectedStepIndex = -1;
  pendingReset = true;
  widgetCtx = ctx;
  hideChainWidget(ctx);
 }));
}
