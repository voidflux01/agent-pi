// ABOUTME: Pipeline-Team — Hybrid sequential pipeline with parallel agent dispatch
// ABOUTME: Combines agent-chain (sequential phases) with agent-team (parallel dispatch) plus Alt+P overlay
/**
 *
 * Pipeline: UNDERSTAND → GATHER → PLAN → EXECUTE → REVIEW
 *
 * Phase 1 (UNDERSTAND): Interactive — primary agent converses with user
 * Phase 2 (GATHER): Parallel scouts explore codebase concurrently
 * Phase 3 (PLAN): Sequential planner creates implementation plan
 * Phase 4 (EXECUTE): Parallel builders implement the plan
 * Phase 5 (REVIEW): Agent-driven loop — reviewer audits, primary decides approve/re-dispatch
 *
 * Commands:
 *   /pipeline            — select pipeline config from YAML (opt-in activation)
 *   /pipeline-resume     — restore the last durable pipeline snapshot
 *   /pipeline-status     — full pipeline state notification
 *   /pipeline-reset      — reset pipeline to phase 1
 *   /pipeline-clear      — clear pipeline widget from screen (keeps pipeline active)
 *   /pipeline-off       — deactivate pipeline and hide UI
 *
 * Usage: pi -e extensions/pipeline-team.ts
 */

import type { AgentToolResult, ExtensionAPI, Theme, ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";
import { registerToolWithExecutor } from "./lib/tool-executor-registry.ts";
import { Type } from "@sinclair/typebox";
import { Text, type AutocompleteItem } from "@mariozechner/pi-tui";
import { readLastAssistantText, sessionUsage, updateHerdrPaneStatus, registerHerdrCommands, herdrWorkerLabel } from "./lib/herdr-client.ts";
import { readFileSync, existsSync, readdirSync, mkdirSync, unlinkSync } from "fs"; import { join, resolve, basename, dirname } from "path";
import { fileURLToPath } from "url";
import { applyExtensionDefaults } from "./lib/themeMap.ts";
import { modePromptMatches } from "./lib/mode-cycler-logic.ts";
import { GRILL_ME_SECTION, ORCHESTRATED_TASK_PROMPT, RESEARCH_ROUTING_COMPACT_PROMPT } from "./lib/mode-prompts.ts";
import {
 coordinationState,
 setActivePipeline,
 onCoordinationModeChange,
 setCoordinationMode,
 resetExecutionVerification,
 setExecutionContract,
} from "./lib/coordination-state.ts";
import { childEnvironment, ensurePiTool, projectWorkerTools } from "./lib/child-runtime.ts";
import { subagentContextBudget } from "./lib/context-budget.ts";
import { outputLine, outputBox, type BarColor, type OutputBoxTheme } from "./lib/output-box.ts";
import { renderVerticalTimeline, renderCollapsedTimeline } from "./lib/pipeline-render.ts";
import { toolCallText } from "./lib/tui/tool-render.ts";
import { hideWidget } from "./lib/tui/widget.ts";
import { DEFAULT_SUBAGENT_MODEL } from "./lib/defaults.ts";
import { boundedHandoff, boundedOutputPreview, buildWorkerInitialPrompt, compactHandoff, composeAgentResult, extractResultBlock, persistFullOutput, resultOneLiner, runBaseName } from "./lib/agent-result-contract.ts";
import { journalAppend, journalUpdate, pruneRunArtifacts, reconcileJournal, registerTaskStatusCommand } from "./lib/agent-task-journal.ts";
import { resolveToolkitWorkerModel } from "./lib/toolkit-cli.ts";
import { loadAgentModelsConfig, parseAgentMdFile, type AgentModelsConfig } from "./lib/agent-defs.ts";
import { displayName } from "./lib/ui-helpers.ts";
import { parsePipelineYaml, phaseRequiresAgentDispatch, pipelineSelectLabel, type PhaseAgentDef, type PhaseDef, type PipelineConfig } from "./lib/parse-pipeline-yaml.ts";
import { currentDispatchAuthorization, explicitDispatchHandler, isExplicitDispatchActive, createSubagentRuntime, withSessionLifecycle } from "./lib/dispatch-runtime.ts";
import { matchNamedOption } from "./lib/named-pick.ts";
import { applyWorkerLaunchPolicy, implementationWorkerPrompt, isExecutionWorker, reviewWorkerPrompt, workerHitToolCap, workerTimeoutMs } from "./lib/worker-budget.ts";
import { discoverResearchTools } from "./lib/research-protocol.ts";
import { bindAcceptanceContract } from "./lib/execution-contract.ts";
import { runAutonomousCompletion, builderRepairDispatcher } from "./lib/autonomous-completion.ts";
import { createWorkerLifecycle } from "./lib/worker-lifecycle.ts";
import { createOrchestrationRun, DEFAULT_ORCHESTRATION_TIMEOUT_MS, type OrchestrationRun } from "./lib/orchestration-run.ts";
import { AGENT_PI_CONFIG } from "./lib/agent-pi-config.ts";
import { reviewerDecision } from "./lib/reviewer-decision.ts";
import { providerModelString } from "./lib/model-inheritance.ts";
import { clearPipelineSnapshot, pipelineSnapshotMatchesPhaseNames, readPipelineSnapshot, writePipelineSnapshot } from "./lib/pipeline-state.ts";
import { scheduleResourceWaves } from "./lib/resource-scheduler.ts";
import { registerWorkflowDispatchHook, readDispatchReceipt } from "./lib/workflow-dispatch.ts";
import { workflowDirection } from "./lib/workflow-direction.ts";

// ── Types ────────────────────────────────────────

interface AgentDef {
 name: string;
 description: string;
 tools: string;
 model: string; // full provider/model ID, empty = use default
 systemPrompt: string;
}

interface AgentState {
 role: string;
 index: number;
 status: "idle" | "running" | "done" | "error";
 task: string;
 elapsed: number;
 lastWork: string;
 output: string;
 toolCount?: number;
 timer?: ReturnType<typeof setInterval>;
 proc?: any;  // ChildProcess ref for escape-cancel
}

type PhaseStatus = "pending" | "active" | "done" | "error" | "skipped";

interface PhaseState {
 def: PhaseDef;
 status: PhaseStatus;
 summary: string;
 agents: AgentState[];
 dispatchCount: number;
 lastDispatchSuccess: boolean;
 lastReceiptId?: string;
}

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
   for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const fullPath = resolve(dir, file);
    const def = parseAgentMdFile(fullPath, modelsConfig);
    if (def && !agents.has(def.name.toLowerCase())) {
     agents.set(def.name.toLowerCase(), def);
    }
   }
  } catch { }
 }

 return agents;
}

// ── Context Helpers ──────────────────────────────

const CONTEXT_MAX = 30000;

function truncateContext(text: string): string {
 if (text.length <= CONTEXT_MAX) return text;
 return text.slice(0, CONTEXT_MAX) + "\n\n... [context truncated at 30000 chars]";
}

function resolveTemplate(
 template: string,
 vars: { task: string; context: string; plan: string; input: string; review: string },
): string {
 return template
  .replace(/\$TASK/g, vars.task)
  .replace(/\$CONTEXT/g, truncateContext(vars.context))
  .replace(/\$PLAN/g, vars.plan)
  .replace(/\$INPUT/g, vars.input)
  .replace(/\$REVIEW/g, vars.review);
}

// ── Extension ────────────────────────────────────


/** D21 auto-advance decision (pure). Single-agent opt-in phase auto-advances
 *  after its joined worker succeeds; review requires APPROVED in the output. */
export function decideAutoAdvance(o: {
 autoAdvance?: boolean;
 agentCount: number;
 status: string;
 isCurrent: boolean;
 isLast: boolean;
 phaseName: string;
 output?: string;
}): boolean {
 if (o.autoAdvance !== true) return false;
 if (o.agentCount !== 1) return false;
 if (o.status !== "done") return false;
 if (!o.isCurrent || o.isLast) return false;
 if (o.phaseName === "review" && !/\bAPPROVED\b/i.test(o.output || "")) return false;
 return true;
}

export default function(pi: ExtensionAPI) {
 registerHerdrCommands(pi);
 let allAgents: Map<string, AgentDef> = new Map();
 let pipelineConfigs: PipelineConfig[] = [];
 let activeConfig: PipelineConfig | null = null;
 let phaseStates: PhaseState[] = [];
 let currentPhaseIndex = 0;
 let widgetCtx: any;
 let unwatchMode: (() => void) | undefined;
 let widgetCollapsed = true;
 let sessionDir = "";
 let contextWindow = 0;
 const lifecycle = createWorkerLifecycle();

 // Accumulated context across phases
 let taskSummary = "";   // $TASK — from phase 1
 let accContext = "";     // $CONTEXT — accumulated from all phases
 let planOutput = "";     // $PLAN — from phase 3
 let reviewOutput = "";   // $REVIEW — from phase 5 (when looping)
 let reviewLoopCount = 0;
 // Completion receipt from the canonical subagent dispatcher. This bridges
 // the async joined-result callback and the parent phase gate.
 registerWorkflowDispatchHook("PIPELINE", {
  context: ({ name, task, batch }) => ({
   phase: phaseStates[currentPhaseIndex]?.def.name,
   phaseIndex: currentPhaseIndex,
   scope: `pipeline:${activeConfig?.name || "unknown"}:${currentPhaseIndex}:${name}:${batch ? "batch" : "single"}`,
  }),
  before: ({ name, batch }) => {
   if (!activeConfig || phaseStates.length === 0) return "PIPELINE dispatch blocked: no active pipeline is selected.";
   const phase = phaseStates[currentPhaseIndex];
   if (!phase || !phaseRequiresAgentDispatch(phase.def)) return `PIPELINE dispatch blocked: ${phase?.def.name || "current phase"} does not accept agent dispatch.`;
   if (phase.agents.some((worker) => worker.status === "running")) return `PIPELINE dispatch blocked: ${phase.def.name.toUpperCase()} already has a running worker; wait for its joined result.`;
   if (phaseDispatchReady(phase)) return `PIPELINE dispatch blocked: ${phase.def.name.toUpperCase()} already has a completed worker; call advance_phase with its bounded result before dispatching again.`;
   const normalize = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/g, "-");
   const configuredRoles = phase.def.agents.map((agent) => normalize(agent.role));
   const role = normalize(name);
   if (!configuredRoles.includes(role)) return `PIPELINE dispatch blocked: ${name} is not configured for phase ${phase.def.name}.`;
   if (phase.def.mode === "parallel" && configuredRoles.length > 1 && !batch) {
    return `PIPELINE dispatch blocked: ${phase.def.name} is configured for parallel dispatch; use subagent_create_batch.`;
   }
   if (phase.def.mode === "sequential" && configuredRoles.length > 1 && batch) {
    return `PIPELINE dispatch blocked: ${phase.def.name} is configured for sequential dispatch; use one joined subagent_create per role.`;
   }
   if (phase.def.mode === "sequential" && configuredRoles.length > 1) {
    const completed = phase.agents.filter((worker) => worker.status === "done").length;
    const expected = configuredRoles[completed];
    if (expected && expected !== role) return `PIPELINE dispatch blocked: step ${completed + 1} of ${phase.def.name} must run ${phase.def.agents[completed]?.role}.`;
   }
   return undefined;
  },
  after: (result) => {
   const phase = phaseStates[currentPhaseIndex];
   if (!phase) return;
   if (result.receiptId && phase.lastReceiptId === result.receiptId) return;
   phase.dispatchCount = (phase.dispatchCount || 0) + 1;
   phase.lastDispatchSuccess = result.status === "done";
   phase.lastReceiptId = result.receiptId;
   const output = result.fullOutput || result.output;
   const worker = {
    role: result.name,
    index: 0,
    status: result.status,
    task: result.task,
    elapsed: 0,
    lastWork: result.output.slice(0, 500),
    output,
   } as AgentState;
   const keepAllWorkers = result.batch || (phase.def.mode === "sequential" && phase.def.agents.length > 1);
   if (keepAllWorkers) {
    const normalize = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/g, "-");
    const existing = phase.agents.findIndex((candidate) => normalize(candidate.role) === normalize(result.name) && candidate.status !== "done");
    if (existing >= 0) phase.agents[existing] = { ...worker, index: existing };
    else phase.agents.push({ ...worker, index: phase.agents.length });
   } else {
    phase.agents = [worker];
   }
   if (!taskSummary) taskSummary = result.task;
   if (phase.def.name.toLowerCase() === "plan") planOutput = output;
   if (phase.def.name.toLowerCase() === "review") reviewOutput = output;

   // Auto-advance (opt-in, dogfood D21): a single-agent phase whose
   // joined worker succeeded moves on without the coordinator having to
   // call advance_phase — the stall cycle-15 saw was the model never
   // advancing after a finished worker. Conservative: only when the phase
   // declares auto_advance: true, exactly one configured agent, the
   // worker actually succeeded, and review phases only when APPROVED.
   const phaseName = phase.def.name.toLowerCase();
   const autoOk = decideAutoAdvance({
    autoAdvance: phase.def.autoAdvance,
    agentCount: phase.def.agents.length,
    status: result.status,
    isCurrent: phaseStates[currentPhaseIndex] === phase,
    isLast: currentPhaseIndex >= phaseStates.length - 1,
    phaseName,
    output,
   });
   if (autoOk) {
    phase.status = "done";
    phase.summary = (output || "").slice(0, 2000);
    phase.lastDispatchSuccess = true;
    const nextIdx = currentPhaseIndex + 1;
    currentPhaseIndex = nextIdx;
    phaseStates[nextIdx].status = "active";
    if (phaseName === "plan") bindPipelinePlan(planOutput);
   }
   updateWidget();
   persistPipelineState();
  },
 });

 function persistPipelineState(): void {
  if (!sessionDir || !activeConfig || phaseStates.length === 0) return;
  try {
   writePipelineSnapshot(sessionDir, {
    pipeline: activeConfig.name,
    currentPhaseIndex,
    taskSummary,
    accContext: truncateContext(accContext),
    planOutput: truncateContext(planOutput),
    reviewOutput: truncateContext(reviewOutput),
    reviewLoopCount,
    phases: phaseStates.map((phase) => ({
     name: phase.def.name,
     status: phase.status,
     summary: phase.summary.slice(0, 4_000),
     dispatchCount: phase.dispatchCount,
     lastDispatchSuccess: phase.lastDispatchSuccess,
     ...(phase.lastReceiptId ? { lastReceiptId: phase.lastReceiptId } : {}),
    })),
   });
  } catch { }
 }

 /** Reconcile the phase gate with worker state after a joined dispatch. */
 function phaseDispatchReady(phase: PhaseState): boolean {
  if (phase.def.name.toLowerCase() === "review" && reviewerDecision(reviewOutput) !== "APPROVED") return false;
  const normalize = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/g, "-");
  const workers = phase.agents || [];
  const configuredRoles = phase.def.agents.map((agent) => normalize(agent.role));
  const completedCounts = new Map<string, number>();
  for (const worker of workers) {
   if (worker.status === "done") completedCounts.set(normalize(worker.role), (completedCounts.get(normalize(worker.role)) || 0) + 1);
  }
  const requiredCounts = new Map<string, number>();
  for (const role of configuredRoles) requiredCounts.set(role, (requiredCounts.get(role) || 0) + 1);
  const allConfiguredWorkersDone = configuredRoles.length > 0
   && Array.from(requiredCounts.entries()).every(([role, count]) => (completedCounts.get(role) || 0) >= count);
  const hasUnresolvedWorker = workers.some((worker) => worker.status === "running" || worker.status === "error");
  // Live worker rows are authoritative. A batch is ready only after every
  // configured role has returned successfully; one successful child must not
  // hide a sibling error.
  if (workers.length > 0) return allConfiguredWorkersDone && !hasUnresolvedWorker;
  const phaseIndex = phaseStates.indexOf(phase);
  const workspaceRoot = dirname(dirname(sessionDir));
  let receipt = phase.lastReceiptId && sessionDir
   ? readDispatchReceipt(workspaceRoot, phase.lastReceiptId)
   : undefined;
  // Recovery path for a completion callback that arrived after the phase
  // snapshot was written: receipts are authoritative and workspace-scoped.
  if (!receipt && sessionDir) {
   try {
    const receiptRoot = join(sessionDir, "dispatch-receipts");
    const candidates = readdirSync(receiptRoot)
     .filter((name) => name.endsWith(".json"))
     .map((name) => readDispatchReceipt(workspaceRoot, name.slice(0, -5)))
     .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
     .filter((candidate) => candidate.context.mode === "PIPELINE" && candidate.context.phaseIndex === phaseIndex)
     .sort((a, b) => b.updatedAt - a.updatedAt);
    receipt = candidates[0];
    if (receipt) phase.lastReceiptId = receipt.id;
   } catch { }
  }
  if ((receipt?.status === "done" || receipt?.status === "consumed")
   && receipt.context.mode === "PIPELINE"
   && receipt.context.phaseIndex === phaseIndex
   && (phase.dispatchCount || 0) >= Math.max(1, configuredRoles.length)) {
   phase.lastDispatchSuccess = true;
   return true;
  }
  return false;
 }

 function restorePipelineState(): boolean {
  const snapshot = readPipelineSnapshot(sessionDir);
  if (!snapshot) return false;
  const config = pipelineConfigs.find((candidate) => candidate.name === snapshot.pipeline);
  if (!config || !pipelineSnapshotMatchesConfig(snapshot, config)) return false;
  activeConfig = config;
  setActivePipeline(config.name);
  currentPhaseIndex = snapshot.currentPhaseIndex;
  taskSummary = snapshot.taskSummary;
  accContext = snapshot.accContext;
  planOutput = snapshot.planOutput;
  reviewOutput = snapshot.reviewOutput;
  reviewLoopCount = snapshot.reviewLoopCount;
  phaseStates = config.phases.map((def, index) => ({
   def,
   status: snapshot.phases[index]!.status,
   summary: snapshot.phases[index]!.summary,
   agents: [],
   dispatchCount: snapshot.phases[index]!.dispatchCount,
   lastDispatchSuccess: snapshot.phases[index]!.lastDispatchSuccess,
   lastReceiptId: snapshot.phases[index]!.lastReceiptId,
  }));
  updateWidget();
  return true;
 }

 function pipelineSnapshotMatchesConfig(snapshot: NonNullable<ReturnType<typeof readPipelineSnapshot>>, config: PipelineConfig): boolean {
  return pipelineSnapshotMatchesPhaseNames(snapshot, config.phases.map((phase) => phase.name));
 }

 // ── Load Config ──────────────────────────────

 function loadConfig(cwd: string) {
  sessionDir = join(cwd, ".pi", "agent-sessions");
  if (!existsSync(sessionDir)) {
   mkdirSync(sessionDir, { recursive: true });
   pruneRunArtifacts(sessionDir); // 7-day rolling retention (archives + journal)
   reconcileJournal(sessionDir); // close rows orphaned by a crashed parent
  }

  const extDir = dirname(fileURLToPath(import.meta.url));
  const securityGuardExtPath = join(extDir, "security-guard.ts");
  const extProjectDir = resolve(extDir, "..");

  // Load model config from .pi/agents/models.json, then scan agent .md files
  const modelsConfig = loadAgentModelsConfig(cwd, extProjectDir);
  allAgents = scanAgentDirs(cwd, extProjectDir, modelsConfig);

  // Look for config in cwd first, fall back to extension's own project dir
  let configPath = join(cwd, ".pi", "agents", "pipeline-team.yaml");
  if (!existsSync(configPath)) {
   configPath = join(extProjectDir, ".pi", "agents", "pipeline-team.yaml");
  }
  if (!existsSync(configPath)) {
   configPath = join(extProjectDir, "agents", "pipeline-team.yaml");
  }
  if (existsSync(configPath)) {
   try {
    pipelineConfigs = parsePipelineYaml(readFileSync(configPath, "utf-8"));
   } catch {
    pipelineConfigs = [];
   }
  } else {
   pipelineConfigs = [];
  }

  // set_mode PIPELINE can race session_start/config loading. In that case
  // the mode-change listener ran before the configs existed and will not be
  // called again (the mode value is already PIPELINE). Reconcile the current
  // mode after loading so the pipeline tools are immediately usable.
  if (coordinationState().mode === "PIPELINE" && !activeConfig && pipelineConfigs.length > 0) {
   const preferred = pipelineConfigs.find((c) => c.name === "plan-build") || pipelineConfigs[0];
   activatePipeline(preferred);
  }
 }

 function activatePipeline(config: PipelineConfig) {
  activeConfig = config;
  setActivePipeline(config.name);
  currentPhaseIndex = 0;
  taskSummary = "";
  accContext = "";
  planOutput = "";
  reviewOutput = "";
  reviewLoopCount = 0;
  resetExecutionVerification();

  phaseStates = config.phases.map(p => ({
   def: p,
   status: "pending" as PhaseStatus,
   summary: "",
   agents: [],
   dispatchCount: 0,
   lastDispatchSuccess: false,
  }));

  if (phaseStates.length > 0) {
   phaseStates[0].status = "active";
  }

  persistPipelineState();
  updateWidget();
 }

 function resetPipeline() {
  if (activeConfig) activatePipeline(activeConfig);
 }


 // ── Widget ───────────────────────────────────

 function clearPipelineUI() {
  if (!widgetCtx) return;
  hideWidget(widgetCtx, "pipeline-team");
  widgetCtx.ui.setStatus("pipeline-team", undefined);
 }

 function deactivatePipeline(ctx?: any): void {
  activeConfig = null;
  clearPipelineSnapshot(sessionDir);
  setActivePipeline(null);
  phaseStates = [];
  const applyMode = (globalThis as any).__piSetMode as undefined | ((mode: string, nextCtx?: any) => void);
  if (coordinationState().mode === "PIPELINE") {
   if (typeof applyMode === "function") applyMode("NORMAL", ctx);
   else setCoordinationMode("NORMAL", ctx);
  }
  clearPipelineUI();
 }

 function updateStatus() {
  if (!widgetCtx) return;
  if (!activeConfig) {
   widgetCtx.ui.setStatus("pipeline-team", undefined);
   return;
  }
  const phase = phaseStates[currentPhaseIndex];
  if (phase) {
   widgetCtx.ui.setStatus("pipeline-team", `PIPELINE:${phase.def.name.toUpperCase()}`);
  }
 }

 function updateWidget() {
  if (!widgetCtx) return;
  if (coordinationState().mode !== "PIPELINE") {
   clearPipelineUI();
   return;
  }
  if (!activeConfig || phaseStates.length === 0) {
   clearPipelineUI();
   return;
  }
  // Only show when agents are actively running
  const hasActiveWork = phaseStates.some((ps) =>
   ps.agents.some((a) => a.status === "running"),
  );
  if (!hasActiveWork) {
   clearPipelineUI();
   return;
  }
  updateStatus();

  widgetCtx.ui.setWidget("pipeline-team", (_tui: any, theme: any) => {
   const text = new Text("", 0, 1);

   return {
    render(width: number): string[] {
     if (!activeConfig || phaseStates.length === 0) return [];
     const renderPhases = phaseStates.map(s => ({
      name: s.def.name,
      status: s.status,
      summary: s.summary,
      agents: s.agents.map(a => ({
       role: a.role,
       index: a.index,
       status: a.status,
       lastWork: a.lastWork,
       task: a.task,
       elapsed: a.elapsed,
      })),
     }));

     const rawLines = widgetCollapsed
      ? renderCollapsedTimeline(renderPhases, currentPhaseIndex, activeConfig!.name, width, theme)
      : renderVerticalTimeline(renderPhases, currentPhaseIndex, width, theme);

     const allDone = phaseStates.every(p => p.status === "done");
     const hasError = phaseStates.some(p => p.status === "error");
     const barColor: BarColor = hasError ? "error" : allDone ? "success" : "accent";
     const outputLines = outputBox(theme as unknown as OutputBoxTheme, barColor, rawLines);

     text.setText(outputLines.join("\n"));
     return text.render(width);
    },
    invalidate() {
     text.invalidate();
    },
   };
  }, { placement: "belowEditor" });
 }

 // ── Subprocess Spawning ──────────────────────

 function spawnAgent(
  agentDef: AgentDef,
  task: string,
  agentState: AgentState,
  ctx: any,
  parentRunId?: string,
  signal?: AbortSignal,
  parentRun?: OrchestrationRun,
 ): Promise<{ output: string; fullOutput: string; fullOutputPath: string; exitCode: number; elapsed: number }> {
  if (!isExplicitDispatchActive()) {
   return Promise.resolve({ output: "Dispatch refused: only an explicit tool or slash command may start a child", fullOutput: "", fullOutputPath: "", exitCode: 126, elapsed: 0 });
  }
  ctx?.ui?.notify?.(`${agentDef.name} started`, "info");
  agentState.status = "running";
  agentState.task = task;
  agentState.elapsed = 0;
  agentState.lastWork = "";
  agentState.output = "";
  updateWidget();

  const startTime = Date.now();
  agentState.timer = lifecycle.trackTimer(setInterval(() => {
   agentState.elapsed = Date.now() - startTime;
   updateWidget();
  }, 1000));

  // Use agent's defined model or fall back to default subagent model.
  // NOTE: We intentionally do NOT inherit the parent model. Each agent
  // should use its explicitly defined model or the lightweight default.
  const model = resolveToolkitWorkerModel(agentDef.name, agentDef.model || providerModelString(ctx?.model) || DEFAULT_SUBAGENT_MODEL);

  const agentKey = `pipeline-${agentDef.name.toLowerCase().replace(/\s+/g, "-")}-${agentState.index}`;
  const agentSessionFile = join(sessionDir, `${agentKey}.json`);

  const extDir = dirname(fileURLToPath(import.meta.url));
  // Loaded only by the visible herdr transport: writes the pane's done
  // marker on the child's first agent_end (an interactive worker stays alive).
  const herdrDoneExtPath = join(extDir, "herdr-done.ts");
  // Resume existing session when one exists (pipeline previously lacked -c).
  const hasSession = existsSync(agentSessionFile);
  // Durable journal record — survives parent restarts (see /agents-status).
  const journalId = runBaseName(agentKey, agentState.index + 1);
  journalAppend(sessionDir, {
   version: 1,
   id: journalId,
   kind: "pipeline",
   agent: agentDef.name,
   mode: "PIPELINE",
   task,
   model,
   cwd: ctx.cwd,
   sessionFile: hasSession ? agentSessionFile : undefined,
   resumed: !!hasSession,
   status: "dispatched",
   startedAt: Date.now(),
   updatedAt: Date.now(),
  });

  const role = agentDef.name.toLowerCase();
  const policy = isExecutionWorker(agentDef.name) ? "execution" : role === "scout" || role === "researcher" ? "recon" : "readonly";
  let workerTools = projectWorkerTools(agentDef.tools, pi.getAllTools(), policy);
  workerTools = ensurePiTool(workerTools, "ask_parent");
  if (agentDef.name.toLowerCase() === "researcher") {
   for (const name of discoverResearchTools(pi.getAllTools())) workerTools = ensurePiTool(workerTools, name);
  }

  const workerTask = hasSession
   ? task
   : buildWorkerInitialPrompt({
    role: agentDef.name,
    task,
    rolePrompt: agentDef.systemPrompt,
    additionalInstructions: [
     isExecutionWorker(agentDef.name) ? implementationWorkerPrompt() : "",
     agentDef.name.toLowerCase() === "reviewer" ? reviewWorkerPrompt() : "",
    ].filter(Boolean).join("\n\n"),
   });
  const args = [
   "--mode", "json",
   "-p",
   "--model", model,
   "--tools", workerTools,
   "--session", agentSessionFile,
  ];

  if (hasSession) {
   args.push("-c");
  }

  args.push(workerTask);

  const textChunks: string[] = [];
  let liveText = "";

  return new Promise((resolvePromise) => {
   // Shared completion path for both transports. Persist the FULL
   // transcript on disk, then compose the compact but complete
   // result index for the next phase agent / final report.
   const finish = (code: number | null, externalFull?: string) => {
    lifecycle.clearTimer(agentState.timer);
    lifecycle.clearProcess(agentState.proc);
    agentState.proc = null;
    agentState.elapsed = Date.now() - startTime;
    updateHerdrPaneStatus(ctx.cwd, journalId, code === 0 ? "done" : "error");
    const output = externalFull ?? textChunks.join("");
    agentState.output = output;
    agentState.status = code === 0 ? "done" : "error";
    agentState.lastWork = resultOneLiner(output, extractResultBlock(output).result)
     || output.split("\n").filter((l: string) => {
      const t = l.trim();
      return t && t !== "## END" && t !== "## RESULT";
     }).pop()
     || "";
    updateWidget();

    ctx.ui.notify(
     `${displayName(agentState.role)} #${agentState.index + 1} ${agentState.status} in ${Math.round(agentState.elapsed / 1000)}s`,
     agentState.status === "done" ? "success" : "error",
    );

    let fullOutputPath = "";
    let composed = output;
    try {
     fullOutputPath = persistFullOutput(sessionDir, runBaseName(agentKey, agentState.index + 1), output);
     const composedResult = composeAgentResult({
      agent: agentDef.name,
      status: agentState.status,
      exitCode: code,
      elapsedMs: agentState.elapsed,
      model,
      outputText: output,
      fullOutputPath,
      maxResultChars: subagentContextBudget(ctx?.getContextUsage?.()?.percent, 1).resultChars,
     });
     composed = compactHandoff({ agent: agentDef.name, status: agentState.status, elapsedMs: agentState.elapsed, model, composed: composedResult, fullOutputPath });
    } catch {
     composed = "[RESULT contract rejected: delivery gate could not persist or inspect the worker transcript]";
     fullOutputPath = "";
    }

    const pu = agentSessionFile ? sessionUsage(agentSessionFile) : null;
    if (parentRun && pu && pu.assistantMessages > 0) {
     parentRun.recordUsage({ totalTokens: pu.totalTokens, costUsd: pu.costUsd });
    }
    journalUpdate(sessionDir, journalId, {
     status: agentState.status,
     exitCode: code,
     elapsedMs: agentState.elapsed,
     sessionFile: code === 0 ? agentSessionFile : undefined,
     outputFile: fullOutputPath || undefined,
     usage: pu && pu.assistantMessages > 0 ? {
      input: pu.input, output: pu.output, cacheRead: pu.cacheRead, cacheWrite: pu.cacheWrite,
      totalTokens: pu.totalTokens, budgetTokens: pu.input + pu.output + pu.cacheWrite, costUsd: Math.round(pu.costUsd * 1e6) / 1e6,
     } : undefined,
    });

    resolvePromise({ output: composed, fullOutput: output, fullOutputPath, exitCode: code ?? 1, elapsed: agentState.elapsed });
   };

   // Transport mechanics are shared; the pipeline owns phase scheduling
   // and only consumes text/status callbacks for its widget.
   const launch = applyWorkerLaunchPolicy(["pi", ...args], agentDef.name);
   const runtimePromise = createSubagentRuntime({
    authorization: currentDispatchAuthorization(),
    command: launch.command,
    cwd: ctx.cwd,
    env: childEnvironment({
     PI_SUBAGENT: "1",
     PI_AGENT_NAME: String(agentDef?.name || "").toLowerCase(),
     PI_PANE_TITLE: herdrWorkerLabel(agentDef?.name || "pipeline", journalId),
     PI_SESSION_FILE: agentSessionFile || undefined,
     PI_AGENT_PI_RUN_ID: parentRunId,
    }),
    launchDir: sessionDir,
    launchId: journalId,
    parentRunId,
    mode: "PIPELINE",
    pollTimeoutMs: workerTimeoutMs(agentDef.name) ?? DEFAULT_ORCHESTRATION_TIMEOUT_MS,
    sessionFile: agentSessionFile,
    herdrDoneExtPath,
    herdrLabel: herdrWorkerLabel(agentDef?.name || "pipeline", journalId),
    herdrPaneKey: journalId,
    onHerdrClosed: () => {
     // The pipeline lifecycle is already owned by the parent run;
     // unlike the standalone widget runtime there is no local epoch
     // token to compare here.
     updateWidget();
    },
    isAborted: () => !!signal?.aborted,
    journal: { dir: sessionDir, id: journalId },
    onProcess: (child) => { agentState.proc = lifecycle.trackProcess(child as any); },
    onStdoutLine: (line) => {
     try {
      const event = JSON.parse(line);
      if (event.type === "message_update") {
       const delta = event.assistantMessageEvent;
       if (delta?.type === "text_delta") {
        const deltaText = delta.delta || "";
        textChunks.push(deltaText);
        liveText = (liveText + deltaText).slice(-8_192);
        const last = liveText.split("\n").filter((l: string) => l.trim()).pop() || "";
        agentState.lastWork = last;
        updateWidget();
       }
      } else if (event.type === "tool_execution_start") {
       agentState.toolCount = (agentState.toolCount || 0) + 1;
       if (workerHitToolCap(agentDef.name, agentState.toolCount) && agentState.proc) {
        try { agentState.proc.kill("SIGTERM"); } catch { }
        agentState.lastWork = "stopped: tool-call cap";
       }
      }
     } catch { }
    },
    onHerdrUpdate: () => {
     try {
      const { text } = readLastAssistantText(agentSessionFile);
      const last = text.split("\n").filter((l: string) => l.trim()).pop() || "";
      if (last) {
       agentState.lastWork = last;
       agentState.output = last;
       updateWidget();
      }
     } catch { }
    },
   });
   runtimePromise.then((result) => {
    finish(result.exitCode, result.outputText);
   }).catch(() => finish(1));

  });
 }

 // ── Dispatch Agents for a Phase ──────────────

 async function dispatchPhaseAgents(
  agentDefs: { role: string; task: string; resources?: string[] }[],
  mode: "parallel" | "sequential",
  ctx: any,
  parentRunId?: string,
  signal?: AbortSignal,
  parentRun?: OrchestrationRun,
 ): Promise<{ outputs: string[]; fullOutputs: string[]; fullOutputPaths: string[]; success: boolean; blockedReason?: string }> {
  if (!isExplicitDispatchActive()) {
   return { outputs: [], fullOutputs: [], fullOutputPaths: [], success: false, blockedReason: "Dispatch refused: only an explicit tool or slash command may start a child" };
  }
  const phaseState = phaseStates[currentPhaseIndex];
  const contextBudget = subagentContextBudget(ctx?.getContextUsage?.()?.percent, agentDefs.length);
  if (contextBudget.maxAgents === 0) {
   return {
    outputs: [],
    fullOutputs: [],
    fullOutputPaths: [],
    success: false,
    blockedReason: `Context is at ${Math.round(ctx?.getContextUsage?.()?.percent ?? 90)}%; compact before dispatching more pipeline agents.`,
   };
  }
  phaseState.agents = agentDefs.map((d, i) => ({
   role: d.role,
   index: i,
   status: "idle" as const,
   task: d.task,
   elapsed: 0,
   lastWork: "",
   output: "",
  }));
  if (agentDefs.length > 0) {
   phaseState.dispatchCount = (phaseState.dispatchCount || 0) + 1;
  }
  persistPipelineState();
  updateWidget();

  const outputs: string[] = [];
  const fullOutputs: string[] = [];
  const fullOutputPaths: string[] = [];
  let allSuccess = true;

  if (mode === "parallel") {
   const configuredParallel = Math.max(1, parseInt(process.env.PI_PIPELINE_MAX_PARALLEL || String(AGENT_PI_CONFIG.orchestration!.pipelineMaxParallel), 10) || AGENT_PI_CONFIG.orchestration!.pipelineMaxParallel!);
   const maxParallel = Math.min(configuredParallel, contextBudget.maxAgents);
   const launch = (d: any, i: number) => {
    const def = allAgents.get(d.role.toLowerCase());
    if (!def) {
     phaseState.agents[i].status = "error";
     phaseState.agents[i].lastWork = `Agent "${d.role}" not found`;
     updateWidget();
     return Promise.resolve({ output: `Agent "${d.role}" not found`, fullOutput: "", fullOutputPath: "", exitCode: 1, elapsed: 0 });
    }
    return spawnAgent(def, d.task, phaseState.agents[i], ctx, parentRunId, signal, parentRun);
   };
   // Bounded fan-out: at most maxParallel agents run at once (env-tunable),
   // so a 12-agent phase cannot spike to 12 simultaneous pi processes.
   const results: Array<Awaited<ReturnType<typeof spawnAgent>>> = [];
   for (const [waveIndex, wave] of scheduleResourceWaves(agentDefs, maxParallel).entries()) {
    parentRun?.record("pipeline.phase.wave", { wave: waveIndex, jobs: wave.map((index) => ({ index, role: agentDefs[index].role, ...(agentDefs[index].resources ? { resources: agentDefs[index].resources } : {}) })) });
    await Promise.all(wave.map(async (i) => { results[i] = await launch(agentDefs[i], i); }));
   }
   for (const r of results) {
    outputs.push(r.output);
    fullOutputs.push(r.fullOutput || "");
    fullOutputPaths.push(r.fullOutputPath || "");
    // A malformed worker RESULT is a bounded quality warning, not a
    // transport/process failure. Preserve the raw output and let the
    // phase handoff and final acceptance gate decide whether it is usable;
    // otherwise one formatting mistake deadlocks the whole pipeline.
    if (r.exitCode !== 0) allSuccess = false;
   }
  } else {
   // Sequential — each agent's output becomes $INPUT for next
   let input = "";
   for (let i = 0; i < agentDefs.length; i++) {
    const d = agentDefs[i];
    const def = allAgents.get(d.role.toLowerCase());
    if (!def) {
     phaseState.agents[i].status = "error";
     phaseState.agents[i].lastWork = `Agent "${d.role}" not found`;
     updateWidget();
     outputs.push(`Agent "${d.role}" not found`);
     fullOutputs.push("");
     fullOutputPaths.push("");
     allSuccess = false;
     break;
    }

    const task = d.task.replace(/\$INPUT/g, input);
    const result = await spawnAgent(def, task, phaseState.agents[i], ctx, parentRunId, signal, parentRun);
    outputs.push(result.output);
    fullOutputs.push(result.fullOutput || "");
    fullOutputPaths.push(result.fullOutputPath || "");
    input = result.output;

    if (result.exitCode !== 0) {
     allSuccess = false;
     break;
    }
   }
  }

  persistPipelineState();
  return { outputs, fullOutputs, fullOutputPaths, success: allSuccess };
 }

 function bindPipelinePlan(planText: string): void {
  const bound = bindAcceptanceContract(planText, "pipeline");
  setExecutionContract("error" in bound ? undefined : bound);
 }

 // ── Tools ────────────────────────────────────

 registerToolWithExecutor(pi, {
  name: "advance_phase",
  label: "Advance Phase",
  description: "Move pipeline to next phase after current work is done. UNDERSTAND may advance without dispatch. PLAN/BUILD/GATHER/EXECUTE/REVIEW require canonical joined subagent dispatch first. Final advance runs shared independent verification with bounded joined repair; only PASS completes pipeline.",
  parameters: Type.Object({
   summary: Type.String({ description: "Summary of what was accomplished in this phase / the clarified task" }),
   skip_to: Type.Optional(Type.String({ description: "Optional: skip to a specific phase name (e.g. 'plan' to skip gather)" })),
  }),

  execute: explicitDispatchHandler("pipeline-team", async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
   const { summary, skip_to } = params as { summary: string; skip_to?: string };

   if (!activeConfig || phaseStates.length === 0) {
    return { content: [{ type: "text", text: "No pipeline active." }], details: {} };
   }

   const current = phaseStates[currentPhaseIndex];
   if (phaseRequiresAgentDispatch(current.def) && !phaseDispatchReady(current)) {
    const hint = current.def.agents[0]?.role || "the configured agent";
    return {
     content: [{ type: "text", text: `Cannot leave ${current.def.name.toUpperCase()}: call subagent_create successfully (e.g. ${hint}), resolve all agent errors, wait for ## RESULT, then advance_phase with that summary. Gate state: dispatchCount=${current.dispatchCount || 0}, lastDispatchSuccess=${current.lastDispatchSuccess}, workers=${(current.agents || []).map((worker) => `${worker.role}:${worker.status}`).join(",") || "none"}.` }],
     details: {
      error: true,
      phase: current.def.name,
      dispatchCount: current.dispatchCount || 0,
      lastDispatchSuccess: current.lastDispatchSuccess,
      workers: (current.agents || []).map((worker) => ({ role: worker.role, status: worker.status })),
     },
    };
   }

   phaseStates[currentPhaseIndex].status = "done";
   phaseStates[currentPhaseIndex].summary = summary;
   if (current.def.name.toLowerCase() === "plan") {
    bindPipelinePlan(planOutput);
   }

   if (currentPhaseIndex === 0) {
    taskSummary = summary;
   }
   accContext = boundedHandoff(
    `## Phase ${currentPhaseIndex + 1}: ${phaseStates[currentPhaseIndex].def.name}\n${summary}\n\n${accContext}`,
   );

   let nextIndex = currentPhaseIndex + 1;
   if (skip_to) {
    const target = phaseStates.findIndex(p => p.def.name.toLowerCase() === skip_to.toLowerCase());
    if (target > currentPhaseIndex) {
     for (let i = currentPhaseIndex + 1; i < target; i++) {
      phaseStates[i].status = "skipped" as PhaseStatus;
      phaseStates[i].summary = `Skipped to ${skip_to}`;
     }
     nextIndex = target;
    }
   }

   if (nextIndex >= phaseStates.length) {
    const contractText = (planOutput || taskSummary).trim();
    if (!contractText) {
     phaseStates[currentPhaseIndex].status = "active";
     persistPipelineState();
     return { content: [{ type: "text", text: "Pipeline completion blocked: no phase produced a verifiable task Objective." }], details: { error: true, completionBlocked: true, phase: "verification" } };
    }
    bindPipelinePlan(contractText);
    const bound = bindAcceptanceContract(contractText, "pipeline");
    if (!bound.objective.trim()) {
     phaseStates[currentPhaseIndex].status = "active";
     persistPipelineState();
     return { content: [{ type: "text", text: "Pipeline completion blocked: no verifiable task Objective." }], details: { error: true, completionBlocked: true, phase: "verification" } };
    }
    const repairPhase = phaseStates.find((phase) => /^(execute|build)$/i.test(phase.def.name));
    const repairRole = repairPhase?.def.agents[0]?.role || "builder";
    const autonomous = await runAutonomousCompletion({
     contract: bound,
     cwd: _ctx.cwd || process.cwd(),
     mode: "PIPELINE",
     signal: _signal,
     parentRunId: process.env.PI_AGENT_PI_RUN_ID,
     risk: "low",
     dispatchRepair: builderRepairDispatcher(_ctx, repairRole),
    });
    if (!autonomous.allowed) {
     phaseStates[currentPhaseIndex].status = "active";
     persistPipelineState();
     updateWidget();
     return { content: [{ type: "text", text: `Pipeline completion blocked: ${autonomous.reason || autonomous.status}. Do not output done:true.` }], details: { error: true, completionBlocked: true, phase: "verification", status: autonomous.status, attempts: autonomous.attempts, receipt: autonomous.receipt } };
    }
    deactivatePipeline(_ctx);
    return {
     content: [{ type: "text", text: "Pipeline complete! All phases finished." }],
     details: { phase: "complete", summary, status: "PASS", attempts: autonomous.attempts },
    };
   }

   currentPhaseIndex = nextIndex;
   phaseStates[currentPhaseIndex].status = "active";
   persistPipelineState();
   updateWidget();

   const phase = phaseStates[currentPhaseIndex].def;
   return {
    content: [{ type: "text", text: `Advanced to phase: ${phase.name.toUpperCase()} — ${phase.description}\nMode: ${phase.mode}\nAgents: ${phase.agents.length}` }],
    details: { phase: phase.name, mode: phase.mode },
   };
  }) as any,


  renderCall(args: Record<string, unknown>, theme: Theme) {
   const summary = (args as any).summary || "";
   const text = toolCallText(theme, "advance_phase ", summary);
   return new Text(outputLine(theme as unknown as OutputBoxTheme, "accent", text), 0, 0);
  },

  renderResult(result: AgentToolResult<unknown>, _options: ToolRenderResultOptions, theme: Theme) {
   const text = result.content[0];
   const msg = text?.type === "text" ? text.text : "";
   return new Text(outputLine(theme as unknown as OutputBoxTheme, "success", msg), 0, 0);
  },
 });

 registerToolWithExecutor(pi, {
  name: "pipeline_status",
  label: "Pipeline Status",
  description: "Returns the current pipeline state — phases, current phase, accumulated context summary. No parameters needed.",
  parameters: Type.Object({}),

  async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
   if (!activeConfig) {
    return { content: [{ type: "text", text: "No pipeline active." }], details: {} };
   }

   const phases = phaseStates.map((ps, i) => {
    const marker = i === currentPhaseIndex ? "→ " : "  ";
    return `${marker}${ps.def.name.toUpperCase()} [${ps.status}]${ps.summary ? ": " + ps.summary.slice(0, 100) : ""}`;
   }).join("\n");

   // Explicit next action: a model that gets lost mid-pipeline (dogfood
   // D16) needs the current phase to say what to do, not just list state.
   const cur = phaseStates[currentPhaseIndex];
   let nextAction = "(pipeline finished — verify + report)";
   if (cur && cur.status !== "done") {
    if (phaseRequiresAgentDispatch(cur.def)) {
     nextAction = phaseDispatchReady(cur)
      ? `call advance_phase with the bounded ## RESULT summary (phase worker done).`
      : `dispatch the configured worker via subagent_create / subagent_create_batch (roles: ${cur.def.agents.map((a) => a.role).join(", ") || "see config"}), wait for its ## RESULT, then call advance_phase with that summary. Do not advance on a self-written summary.`;
    } else {
     nextAction = `this phase (${cur.def.name.toUpperCase()}) completes without agent dispatch — do its work with your own tools, then call advance_phase.`;
    }
   }

   const status = [
    `Pipeline: ${activeConfig.name}`,
    `Current Phase: ${phaseStates[currentPhaseIndex]?.def.name.toUpperCase() || "none"} (${currentPhaseIndex + 1}/${phaseStates.length})`,
    `Review Loops: ${reviewLoopCount}/${activeConfig.review_max_loops}`,
    ``,
    `Next action: ${nextAction}`,
    ``,
    `Phases:`,
    phases,
    ``,
    `Task: ${taskSummary || "(not yet clarified)"}`,
    `Context Length: ${accContext.length} chars`,
    `Plan: ${planOutput ? planOutput.slice(0, 200) + "..." : "(none yet)"}`,
   ].join("\n");

   return {
    content: [{ type: "text", text: status }],
    details: { phase: currentPhaseIndex, total: phaseStates.length, reviewLoops: reviewLoopCount },
   };
  },

  renderCall(_args: Record<string, unknown>, theme: Theme) {
   return new Text(outputLine(theme as unknown as OutputBoxTheme, "accent", theme.bold("pipeline_status")), 0, 0);
  },

  renderResult(result: AgentToolResult<unknown>, _options: ToolRenderResultOptions, theme: Theme) {
   const text = result.content[0];
   const msg = text?.type === "text" ? text.text : "";
   return new Text(outputLine(theme as unknown as OutputBoxTheme, "accent", msg), 0, 0);
  },
 });

 // ── Commands ──────────────────────────────────

 registerTaskStatusCommand(pi, () => sessionDir);

 pi.registerCommand("pipeline", {
  description: "Select a pipeline: /pipeline or /pipeline <name>",
  getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
   const items = pipelineConfigs.map((pipeline) => ({ value: pipeline.name, label: pipeline.name }));
   const filtered = items.filter((item) => item.value.startsWith(prefix.trim()));
   return filtered.length > 0 ? filtered : null;
  },
  handler: async (args, ctx) => {
   widgetCtx = ctx;
   if (pipelineConfigs.length === 0) {
    ctx.ui.notify("No pipelines in .pi/agents/pipeline-team.yaml", "warning");
    return;
   }

   const named = matchNamedOption(pipelineConfigs.map((c) => c.name), args || "");
   let picked = named ? pipelineConfigs.find((c) => c.name === named) : undefined;
   if (!picked) {
    const options = pipelineConfigs.map(c => pipelineSelectLabel(c));
    const choice = await ctx.ui.select("Select Pipeline", options);
    if (choice === undefined) return;
    picked = pipelineConfigs[options.indexOf(choice)];
   }
   if (!picked) return;
   activatePipeline(picked);
   const applyMode = (globalThis as any).__piSetMode as undefined | ((mode: string, nextCtx?: typeof ctx) => void);
   if (typeof applyMode === "function") applyMode("PIPELINE", ctx);
   else setCoordinationMode("PIPELINE");
   updateStatus();
   const flow = activeConfig!.phases.map((p) => p.name).join(" → ");
   ctx.ui.notify(`Pipeline ${activeConfig!.name} active (${flow}). Mode is PIPELINE.`, "info");
  },
 });

 pi.registerCommand("pipeline-resume", {
  description: "Resume the last durable pipeline snapshot",
  handler: async (_args, ctx) => {
   widgetCtx = ctx;
   if (!restorePipelineState()) {
    ctx.ui.notify("No compatible pipeline snapshot found.", "warning");
    return;
   }
   const applyMode = (globalThis as any).__piSetMode as undefined | ((mode: string, nextCtx?: typeof ctx) => void);
   if (typeof applyMode === "function") applyMode("PIPELINE", ctx);
   else setCoordinationMode("PIPELINE");
   updateStatus();
   ctx.ui.notify(`Resumed pipeline ${activeConfig!.name} at ${phaseStates[currentPhaseIndex]!.def.name.toUpperCase()}.`, "info");
  },
 });

 pi.registerCommand("pipeline-status", {
  description: "Show full pipeline state",
  handler: async (_args, ctx) => {
   if (!activeConfig) {
    ctx.ui.notify("No pipeline active", "warning");
    return;
   }

   const phases = phaseStates.map((ps, i) => {
    const marker = i === currentPhaseIndex ? "→ " : "  ";
    const agents = ps.agents.length > 0
     ? ` (${ps.agents.filter(a => a.status === "done").length}/${ps.agents.length} agents done)`
     : "";
    return `${marker}${ps.def.name.toUpperCase()} [${ps.status}]${agents}`;
   }).join("\n");

   ctx.ui.notify(
    `Pipeline: ${activeConfig.name}\n\n${phases}\n\nReview loops: ${reviewLoopCount}/${activeConfig.review_max_loops}`,
    "info",
   );
  },
 });


 pi.registerCommand("pipeline-reset", {
  description: "Reset pipeline to phase 1",
  handler: async (_args, ctx) => {
   widgetCtx = ctx;
   resetPipeline();
   ctx.ui.notify("Pipeline reset to phase 1", "info");
   updateStatus();
  },
 });

 pi.registerCommand("pipeline-off", {
  description: "Deactivate pipeline and hide UI",
  handler: async (_args, ctx) => {
   widgetCtx = ctx;
   deactivatePipeline(ctx);
   ctx.ui.notify("Pipeline deactivated. Use /pipeline to select one.", "info");
  },
 });
 // ── Alt+P Shortcut ──────────────────────────

 pi.registerShortcut("alt+p", {
  description: "Toggle pipeline widget collapse/expand",
  handler: async (ctx) => {
   widgetCtx = ctx;
   if (!activeConfig) {
    ctx.ui.notify("No pipeline active. Use /pipeline to select one.", "info");
    return;
   }
   widgetCollapsed = !widgetCollapsed;
   updateWidget();
  },
 });

 // ── System Prompt (dynamic per-phase) ────────

 pi.on("before_agent_start", async (_event, _ctx) => {
  // Mode gate: only the explicitly selected mode may inject this prompt
  const mode = coordinationState().mode;
  if (!modePromptMatches(mode, "PIPELINE")) return {};

  if (!activeConfig || phaseStates.length === 0) return {};

  const phase = phaseStates[currentPhaseIndex];
  const phaseNameLower = phase.def.name.trim().toLowerCase();
  const phaseName = phaseNameLower.toUpperCase();

  // Build agent catalog for dispatch
  const agentCatalog = Array.from(allAgents.values())
   .map(a => `- **${displayName(a.name)}** (dispatch as \`${a.name}\`): ${a.description}`)
   .join("\n");

  // Pipeline status summary
  const phasesSummary = phaseStates.map((ps, i) => {
   const marker = i === currentPhaseIndex ? "→ " : "  ";
   return `${marker}${ps.def.name.toUpperCase()} [${ps.status}]`;
  }).join("\n");

  // Context summary
  const contextSummary = accContext
   ? `\n## Accumulated Context\n${truncateContext(accContext)}`
   : "";

  const planSection = planOutput
   ? `\n## Implementation Plan\n${truncateContext(planOutput)}`
   : "";

  const reviewSection = reviewOutput
   ? `\n## Last Review (loop ${reviewLoopCount}/${activeConfig.review_max_loops})\n${truncateContext(reviewOutput)}`
   : "";

  // Phase-specific instructions
  let phaseInstructions = "";

  if (phaseNameLower === "understand") {
   phaseInstructions = `## Phase Instructions: UNDERSTAND
You are in the UNDERSTAND phase. Your job is to:
1. Analyze the task and classify its complexity
2. Use your codebase tools to verify assumptions
3. When the task is fully clarified, call \`advance_phase\` with a detailed summary

## Task Complexity Routing

Before proceeding, classify the task:

**SIMPLE** — Do it yourself. No pipeline needed.
- Reading files, checking status, listing contents
- Quick lookups, answering questions, single small edits
→ Use your own tools directly. Do NOT call advance_phase.

**MEDIUM** — Shortened pipeline. Skip GATHER.
- Focused 1-2 file changes where scope is clear
- Bug fixes where location is known
→ Call advance_phase with skip_to: "plan" (or skip_to: "execute" if obvious)

**COMPLEX** — Full pipeline.
- Multi-file features, refactors, architectural changes
- Tasks needing codebase exploration first
→ Call advance_phase normally (all phases)

Do NOT dispatch agents in this phase. Converse directly with the user.
Call \`advance_phase\` with a comprehensive task summary when ready to proceed.`;

  } else if (phaseNameLower === "gather") {
   phaseInstructions = `## Phase Instructions: GATHER
				You are in the GATHER phase. Dispatch scout agents in parallel only when local context is unfamiliar or independently scoped work requires it; reuse existing scoped findings and report verified terminal results directly. When the task needs current external facts, also dispatch one researcher in parallel. If no compatible web capability is available, record the gap and continue.
				Use \`subagent_create_batch\` for independent workers, or \`subagent_create\` with \`join: true\` for one worker, and wait for bounded results.
				${RESEARCH_ROUTING_COMPACT_PROMPT}
				Review their findings, then call \`advance_phase\` with a summary.

Default agents from config:
${phase.def.agents.map((a, i) => `${i + 1}. ${a.role}: ${a.task_template.slice(0, 100)}`).join("\n")}`;

  } else if (phaseNameLower === "research") {
   phaseInstructions = `## Phase Instructions: RESEARCH
				You are in the RESEARCH phase. Dispatch the configured researcher with \`subagent_create\` and \`join: true\`. Require source URLs, retrieval dates, verified facts, uncertainty, conflicts, and failures in its bounded ## RESULT. Do not present unsupported external claims as facts.
				Wait for the researcher result, then call \`advance_phase\` with that bounded summary.

Default agents from config:
${phase.def.agents.map((a, i) => `${i + 1}. ${a.role}: ${a.task_template.slice(0, 100)}`).join("\n")}`;

  } else if (phaseNameLower === "plan") {
   phaseInstructions = `## Phase Instructions: PLAN
				You are in the PLAN phase. Dispatch the configured planner with \`subagent_create\` and \`join: true\` — do not write the plan yourself. Never call advance_phase until that call has returned the planner's result.
The planner's output must include a complete task contract with a concrete Objective plus any relevant Scope, Acceptance Criteria, Evidence Requirements, and explainable evidence. Pipeline completion is decided by the independent verifier's Objective review, not by a required command.
Wait for the planner's ## RESULT, then call \`advance_phase\` with that summary. The plan is stored as $PLAN.`;

  } else if (phaseNameLower === "execute" || phaseNameLower === "build") {
   phaseInstructions = `## Phase Instructions: ${phaseName}
				Dispatch builder agents with \`subagent_create\` and \`join: true\`. Do not implement files yourself.
Wait for ## RESULT, then call \`advance_phase\`.`;

  } else if (phaseNameLower === "review") {
   phaseInstructions = `## Phase Instructions: REVIEW
				You are in the REVIEW phase (loop ${reviewLoopCount + 1}/${activeConfig.review_max_loops}).
				Dispatch a reviewer agent with \`join: true\` to audit the implementation.
After reviewing the output:
- If the reviewer says APPROVED → call \`advance_phase\`. Completing still requires the complete task contract, an explainable Objective decision, and \`verify_execution\` to report no Critical/High findings, including plan-build pipelines whose last phase is build.
				- If issues found and loops remaining → use \`subagent_create\` with \`join: true\` to fix issues, then review again
- Max review loops: ${activeConfig.review_max_loops}`;
  }

  return {
   systemPrompt: `You are orchestrating a pipeline called "${activeConfig.name}".

${ORCHESTRATED_TASK_PROMPT}

				You have full codebase tools AND pipeline tools (advance_phase, subagent_create, subagent_create_batch, pipeline_status).

				## Pipeline boundary (required)
				- This is PIPELINE. Use subagent_create for each configured phase worker, then advance_phase only after that call's bounded RESULT returns.
				- This is not PLAN mode: never call \`show_plan\` or \`show_spec\` as a substitute for \`advance_phase\`.
				- Do not dispatch a second worker for the same phase after a joined worker has returned; pass its bounded RESULT to \`advance_phase\` immediately.
				- UNDERSTAND is the only phase that may advance without dispatch; every configured worker phase must dispatch before advancing.

## Direct work inside the active pipeline
- Read-only checks such as reading a file, checking status, or listing contents are allowed during analysis.
- Any edit, bash command, phase advance, or agent dispatch requires an active task.
- Trivial work should remain in NORMAL instead of activating a pipeline.

${GRILL_ME_SECTION}

## Current Phase: ${phaseName}
${phase.def.description}

## Pipeline Progress
${phasesSummary}

${phaseInstructions}

## Available Agents for Dispatch
${agentCatalog}

## Task
${taskSummary || "(Phase 1: Ask the user what they want to accomplish)"}
${contextSummary}${planSection}${reviewSection}

## Tools
				- \`advance_phase\`: Move to next phase after this phase's subagent_create workers have finished (required summary from their RESULT)
				- \`subagent_create\` / \`subagent_create_batch\`: Send the configured phase workers and return bounded results
- \`pipeline_status\`: Check current pipeline state
- Plus all standard codebase tools (read, write, edit, bash, etc.)`,
  };
 });

 // ── Session Start ────────────────────────────

 pi.on("session_start", async (_event, _ctx) => withSessionLifecycle(async () => {
  applyExtensionDefaults(import.meta.url, _ctx);

  // Clear widgets from previous session
  widgetCtx = _ctx;
  clearPipelineUI();
  unwatchMode?.();
  unwatchMode = onCoordinationModeChange((mode, _previous, ctx) => {
   if (ctx?.ui) widgetCtx = ctx as typeof widgetCtx;
   if (mode !== "PIPELINE") {
    // Leaving PIPELINE is a cancellation boundary; hidden workers must
    // not continue consuming resources after a mode change.
    lifecycle.stopAll();
    clearPipelineUI();
    return;
   }
   if (!activeConfig && pipelineConfigs.length > 0) {
    const preferred = pipelineConfigs.find((c) => c.name === "plan-build") || pipelineConfigs[0];
    activatePipeline(preferred);
   }
   updateWidget();
  });
  contextWindow = _ctx.model?.contextWindow || 0;

  loadConfig(_ctx.cwd);

  // Preserve worker sessions when a valid snapshot still matches the loaded
  // pipeline. They are the resume material behind /pipeline-resume; deleting
  // them here would leave only phase metadata and force every worker to start
  // from scratch after a parent restart.
  const sessDir = join(_ctx.cwd, ".pi", "agent-sessions");
  const snapshot = readPipelineSnapshot(sessDir);
  const resumable = snapshot && pipelineConfigs.some((config) => pipelineSnapshotMatchesConfig(snapshot, config));
  if (!resumable && existsSync(sessDir)) {
   for (const f of readdirSync(sessDir)) {
    if (f.startsWith("pipeline-") && f.endsWith(".json")) {
     try { unlinkSync(join(sessDir, f)); } catch { }
    }
   }
  }

  if (pipelineConfigs.length === 0) {
   activeConfig = null;
   phaseStates = [];
   clearPipelineUI();
   _ctx.ui.notify("No pipelines found in .pi/agents/pipeline-team.yaml", "warning");
   return;
  }

  // Do not auto-activate on boot. /mode PIPELINE or /pipeline <name> activates.
  activeConfig = null;
  setActivePipeline(null);
  phaseStates = [];
  clearPipelineUI();
  (globalThis as any).__piActivatePipeline = (ctx?: typeof _ctx): boolean => {
   if (coordinationState().mode !== "PIPELINE" || activeConfig || pipelineConfigs.length === 0) return false;
   const preferred = pipelineConfigs.find((c) => c.name === "plan-build") || pipelineConfigs[0];
   activatePipeline(preferred);
   if (ctx?.ui) widgetCtx = ctx as typeof widgetCtx;
   updateStatus();
   return true;
  };

  // ── Expose global hooks for escape-cancel integration ────────────
  (globalThis as any).__piKillPipelineProc = (): boolean => {
   let killed = false;
   for (const phase of phaseStates) {
    for (const agent of phase.agents) {
     if (agent.proc && agent.status === "running") {
      try { agent.proc.kill("SIGTERM"); } catch { }
      killed = true;
     }
    }
   }
   return killed;
  };
  (globalThis as any).__piHasRunningPipeline = (): boolean => {
   for (const phase of phaseStates) {
    for (const agent of phase.agents) {
     if (agent.status === "running") return true;
    }
   }
   return false;
  };
 }));

 pi.on("session_shutdown", async (_event, _ctx) => {
  lifecycle.stopAll();
  unwatchMode?.();
  unwatchMode = undefined;
  for (const phase of phaseStates) {
   for (const agent of phase.agents) {
    if (agent.timer) {
     clearInterval(agent.timer);
     agent.timer = undefined;
    }
    if (agent.proc && agent.status === "running") {
     try { agent.proc.kill("SIGTERM"); } catch { }
     agent.proc = undefined;
    }
   }
  }
  (globalThis as any).__piActivatePipeline = undefined;
  (globalThis as any).__piKillPipelineProc = undefined;
  (globalThis as any).__piHasRunningPipeline = undefined;
  activeConfig = null;
  phaseStates = [];
  setActivePipeline(null);
  clearPipelineUI();
  widgetCtx = undefined;
 });

 pi.on("session_before_switch", async (_event, ctx) => withSessionLifecycle(async () => {
  // /new can switch sessions without a shutdown event. Invalidate and stop
  // every pipeline-owned worker before the replacement session is usable.
  lifecycle.stopAll();
  for (const phase of phaseStates) {
   for (const agent of phase.agents) {
    if (agent.timer) {
     clearInterval(agent.timer);
     agent.timer = undefined;
    }
    if (agent.proc && agent.status === "running") {
     try { agent.proc.kill("SIGTERM"); } catch { }
     agent.proc = undefined;
    }
   }
  }
  phaseStates = [];
  activeConfig = null;
  setActivePipeline(null);
  unwatchMode?.();
  unwatchMode = undefined;
  widgetCtx = ctx;
  clearPipelineUI();
 }));
}
