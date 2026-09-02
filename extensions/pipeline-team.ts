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

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerToolWithExecutor } from "./lib/tool-executor-registry.ts";
import { Type } from "@sinclair/typebox";
import {
	Box, Text, Container, Spacer, Markdown, type AutocompleteItem,
	matchesKey, Key, truncateToWidth, visibleWidth,
} from "@mariozechner/pi-tui";
import { DynamicBorder, getMarkdownTheme as getPiMdTheme } from "@mariozechner/pi-coding-agent";
import { readLastAssistantText, sessionUsage, updateHerdrPaneStatus, registerHerdrCommands, herdrWorkerLabel } from "./lib/herdr-client.ts";
import { readFileSync, existsSync, readdirSync, mkdirSync, unlinkSync } from "fs";
import { join, resolve, basename, dirname } from "path";
import { fileURLToPath } from "url";
import { applyExtensionDefaults } from "./lib/themeMap.ts";
import { modePromptMatches } from "./lib/mode-cycler-logic.ts";
import { GRILL_ME_SECTION, ORCHESTRATED_TASK_PROMPT, RESEARCH_ROUTING_PROMPT } from "./lib/mode-prompts.ts";
import {
	coordinationState,
	setActivePipeline,
	onCoordinationModeChange,
	setCoordinationMode,
	bumpVerifierAttempt,
	getExecutionContract,
	getVerifierReceipt,
	resetExecutionVerification,
	setExecutionContract,
	setVerifierReceipt,
} from "./lib/coordination-state.ts";
import { childEnvironment, ensurePiTool } from "./lib/child-runtime.ts";
import { subagentContextBudget } from "./lib/context-budget.ts";
import { outputLine, outputBox, type BarColor } from "./lib/output-box.ts";
import { renderVerticalTimeline, renderCollapsedTimeline, statusButton } from "./lib/pipeline-render.ts";
import { DEFAULT_SUBAGENT_MODEL } from "./lib/defaults.ts";
import { boundedHandoff, boundedOutputPreview, buildAgentResultContractPrompt, compactHandoff, composeAgentResult, extractResultBlock, persistFullOutput, resultOneLiner, runBaseName } from "./lib/agent-result-contract.ts";
import { journalAppend, journalUpdate, pruneRunArtifacts, reconcileJournal, registerTaskStatusCommand } from "./lib/agent-task-journal.ts";
import { resolveToolkitWorkerModel } from "./lib/toolkit-cli.ts";
import { loadAgentModelsConfig, resolveAgentModelString, type AgentModelsConfig } from "./lib/agent-defs.ts";
import { parsePipelineYaml, phaseRequiresAgentDispatch, pipelineSelectLabel, type PhaseAgentDef, type PhaseDef, type PipelineConfig } from "./lib/parse-pipeline-yaml.ts";
import { currentDispatchAuthorization, explicitDispatchHandler, isExplicitDispatchActive, run as runDispatch, withSessionLifecycle } from "./lib/dispatch-runtime.ts";
import { matchNamedOption } from "./lib/named-pick.ts";
import { applyWorkerLaunchPolicy, implementationWorkerPrompt, isExecutionWorker, reviewWorkerPrompt, workerHitToolCap, workerTimeoutMs } from "./lib/worker-budget.ts";
import { discoverResearchTools } from "./lib/research-protocol.ts";
import { bindAcceptanceContract, emptyContract } from "./lib/execution-contract.ts";
import { verifierAction, DEFAULT_VERIFIER_ATTEMPTS } from "./lib/verification-policy.ts";
import { pipelineCompleteDecision } from "./lib/execution-gate.ts";
import { runAcceptanceVerifier } from "./lib/isolated-verifier.ts";
import { buildWorkspaceManifest } from "./lib/workspace-manifest.ts";
import { normalizeRunStatus } from "./lib/run-state.ts";
import { createWorkerLifecycle } from "./lib/worker-lifecycle.ts";
import { createOrchestrationRun, DEFAULT_ORCHESTRATION_TIMEOUT_MS, type OrchestrationRun } from "./lib/orchestration-run.ts";
import { clearPipelineSnapshot, pipelineSnapshotMatchesPhaseNames, readPipelineSnapshot, writePipelineSnapshot } from "./lib/pipeline-state.ts";
import { scheduleResourceWaves } from "./lib/resource-scheduler.ts";

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
}

// ── Display Name Helper ──────────────────────────

function displayName(name: string): string {
	return name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ── Frontmatter Parser (reused from agent-team) ──

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
		};
	} catch {
		return null;
	}
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
				const def = parseAgentFile(fullPath, modelsConfig);
				if (def && !agents.has(def.name.toLowerCase())) {
					agents.set(def.name.toLowerCase(), def);
				}
			}
		} catch {}
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

export default function (pi: ExtensionAPI) {
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
				})),
			});
		} catch {}
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
		widgetCtx.ui.setWidget("pipeline-team", undefined);
		widgetCtx.ui.setStatus("pipeline-team", undefined);
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
					const outputLines = outputBox(theme, barColor, rawLines);

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
		const model = resolveToolkitWorkerModel(agentDef.name, agentDef.model || DEFAULT_SUBAGENT_MODEL);

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

		let workerTools = ensurePiTool(agentDef.tools, "ask_parent");
		if (agentDef.name.toLowerCase() === "researcher") {
			for (const name of discoverResearchTools(pi.getAllTools())) workerTools = ensurePiTool(workerTools, name);
		}

		const args = [
			"--mode", "json",
			"-p",
			"--model", model,
			"--tools", workerTools,
			"--append-system-prompt", agentDef.systemPrompt + buildAgentResultContractPrompt() + (isExecutionWorker(agentDef.name) ? implementationWorkerPrompt() : "") + (agentDef.name.toLowerCase() === "reviewer" ? reviewWorkerPrompt() : ""),
			"--session", agentSessionFile,
		];

		if (hasSession) {
			args.push("-c");
		}

		args.push(task);

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
					composed = output; // persistence failure must never lose the result itself
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
			const runtimePromise = runDispatch({
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
								try { agentState.proc.kill("SIGTERM"); } catch {}
								agentState.lastWork = "stopped: tool-call cap";
							}
						}
					} catch {}
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
					} catch {}
				},
			});
			runtimePromise.then((result) => {
				finish(result.exitCode, result.outputText);
			}).catch(() => finish(1));

		});	}

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
			const configuredParallel = Math.max(1, parseInt(process.env.PI_PIPELINE_MAX_PARALLEL || "4", 10) || 4);
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

	// ── Ctrl+J Overlay ───────────────────────────

	class AgentGridOverlay {
		private selectedIndex = 0;
		private expandedIndex: number | null = null;
		private scrollOffset = 0;

		constructor(
			private items: AgentState[],
			private onDone: () => void,
		) {
			this.selectedIndex = 0;
		}

		handleInput(data: string, tui: any): void {
			if (matchesKey(data, Key.up)) {
				this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			} else if (matchesKey(data, Key.down)) {
				this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
			} else if (matchesKey(data, Key.enter)) {
				this.expandedIndex = this.expandedIndex === this.selectedIndex ? null : this.selectedIndex;
			} else if (matchesKey(data, Key.escape)) {
				this.onDone();
				return;
			}
			tui.requestRender();
		}

		private ensureVisible(height: number) {
			const pageSize = Math.floor(height / 4);
			if (this.selectedIndex < this.scrollOffset) {
				this.scrollOffset = this.selectedIndex;
			} else if (this.selectedIndex >= this.scrollOffset + pageSize) {
				this.scrollOffset = this.selectedIndex - pageSize + 1;
			}
		}

		render(width: number, height: number, theme: any): string[] {
			this.ensureVisible(height);

			const container = new Container();

			// Header
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			const phaseName = phaseStates[currentPhaseIndex]?.def.name.toUpperCase() || "PIPELINE";
			container.addChild(new Text(
				`${theme.fg("accent", theme.bold(` AGENTS — ${phaseName}`))} ${theme.fg("dim", "|")} ${theme.fg("success", this.items.length.toString())} agents`,
				1, 0,
			));
			container.addChild(new Spacer(1));

			const visibleItems = this.items.slice(this.scrollOffset);

			visibleItems.forEach((item, idx) => {
				const absoluteIndex = idx + this.scrollOffset;
				const isSelected = absoluteIndex === this.selectedIndex;
				const isExpanded = absoluteIndex === this.expandedIndex;

				const cardBox = new Box(1, 0, (s) => isSelected ? theme.bg("selectedBg", s) : s);

				const agentLabel = displayName(item.role) + " #" + (item.index + 1);
				const statusBtn = statusButton(item.status, agentLabel, theme);
				const timeStr = item.elapsed > 0 ? ` ${Math.round(item.elapsed / 1000)}s` : "";
				const titleLine = `${statusBtn} ${theme.fg("dim", timeStr)}`;
				cardBox.addChild(new Text(titleLine, 0, 0));

				if (isExpanded && item.output) {
					cardBox.addChild(new Spacer(1));
					const output = item.output.length > 4000
						? item.output.slice(0, 4000) + "\n... [truncated]"
						: item.output;
					cardBox.addChild(new Text(theme.fg("muted", output), 0, 0));
				} else {
					const preview = (item.lastWork || item.task || "—").replace(/\n/g, " ");
					const truncated = preview.length > width - 10 ? preview.slice(0, width - 13) + "..." : preview;
					cardBox.addChild(new Text(theme.fg("dim", "  " + truncated), 0, 0));
				}

				container.addChild(cardBox);
			});

			// Footer
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", " ↑/↓ Navigate • Enter Expand • Esc Close"), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return container.render(width);
		}
	}

	// ── Collect All Agents for Overlay ───────────

	function collectOverlayAgents(): AgentState[] {
		// Current phase agents first, then all others
		const current = phaseStates[currentPhaseIndex]?.agents || [];
		if (current.length > 0) return current;

		// If no current phase agents, show all from all phases
		const all: AgentState[] = [];
		for (const ps of phaseStates) {
			all.push(...ps.agents);
		}
		return all;
	}

	function bindPipelinePlan(planText: string): void {
		const bound = bindAcceptanceContract(planText, "pipeline");
		setExecutionContract("error" in bound ? emptyContract(planText, "pipeline") : bound);
	}

	// ── Tools ────────────────────────────────────

	registerToolWithExecutor(pi, {
		name: "advance_phase",
		label: "Advance Phase",
		description: "Move the pipeline to the next phase after the current phase's work is done. UNDERSTAND may advance without dispatch. PLAN/BUILD/GATHER/EXECUTE/REVIEW require dispatch_agents first — do not advance on a self-written summary.",
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
			if (phaseRequiresAgentDispatch(current.def) && ((current.dispatchCount || 0) === 0 || !current.lastDispatchSuccess)) {
				const hint = current.def.agents[0]?.role || "the configured agent";
				return {
					content: [{ type: "text", text: `Cannot leave ${current.def.name.toUpperCase()}: call dispatch_agents successfully (e.g. ${hint}), resolve all agent errors, wait for ## RESULT, then advance_phase with that summary.` }],
					details: { error: true, phase: current.def.name },
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
				bindPipelinePlan(planOutput);
				const contract = getExecutionContract();
				const manifest = contract ? buildWorkspaceManifest(_ctx.cwd, contract.fingerprint) : undefined;
				const hash = manifest?.hash;
				let receipt = getVerifierReceipt();
				let gate = pipelineCompleteDecision(planOutput, receipt, hash);
				if (!gate.allowed && gate.contract && !String(gate.reason || "").startsWith("合同不可验证")) {
					const attempt = bumpVerifierAttempt();
					const verification = await runAcceptanceVerifier({
						cwd: _ctx.cwd,
						contract: gate.contract,
						attempt,
						parentRunId: process.env.PI_AGENT_PI_RUN_ID,
						mode: coordinationState().mode,
					});
					if (verification.receipt) {
						setVerifierReceipt(verification.receipt);
						receipt = verification.receipt;
						gate = pipelineCompleteDecision(planOutput, receipt, hash);
					} else {
						phaseStates[currentPhaseIndex].status = "active";
						persistPipelineState();
						return { content: [{ type: "text", text: `Verifier could not complete: ${verification.error || "unknown error"}` }], details: { error: true, phase: "verification" } };
					}
				}
				if (!gate.allowed) {
					const attempt = coordinationState().verifierAttempt || 1;
					const status = receipt?.status || "FAIL";
					const action = verifierAction(status, attempt, DEFAULT_VERIFIER_ATTEMPTS, status !== "BLOCKED" && !String(gate.reason || "").startsWith("合同不可验证"));
					if (action === "retry") {
						const executeIndex = phaseStates.findIndex(p => /^(execute|build)$/i.test(p.def.name));
						if (executeIndex >= 0) {
								phaseStates[currentPhaseIndex].status = "pending";
								phaseStates[executeIndex].status = "active";
								phaseStates[executeIndex].lastDispatchSuccess = false;
								phaseStates[executeIndex].summary = `Verifier feedback (attempt ${attempt}): ${receipt?.results.map(r => `${r.raw}: ${r.status}`).join("; ") || gate.reason}`;
							currentPhaseIndex = executeIndex;
							persistPipelineState();
							updateWidget();
							return { content: [{ type: "text", text: `Verifier FAIL (attempt ${attempt}/${DEFAULT_VERIFIER_ATTEMPTS}). Returned to ${phaseStates[executeIndex].def.name.toUpperCase()}; dispatch a builder with the verifier feedback.` }], details: { phase: phaseStates[executeIndex].def.name, verifier: receipt } };
						}
					}
					phaseStates[currentPhaseIndex].status = "active";
					persistPipelineState();
					return { content: [{ type: "text", text: gate.reason || "Pipeline cannot complete without an independent verifier PASS." }], details: { error: true, phase: "verification", verifier: receipt } };
				}
				activeConfig = null;
				clearPipelineSnapshot(sessionDir);
				updateWidget();
				return {
					content: [{ type: "text", text: "Pipeline complete! All phases finished." }],
					details: { phase: "complete", summary },
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


		renderCall(args, theme) {
			const summary = (args as any).summary || "";
			const preview = summary.length > 60 ? summary.slice(0, 57) + "..." : summary;
			const text =
				theme.fg("toolTitle", theme.bold("advance_phase ")) +
				theme.fg("muted", preview);
			return new Text(outputLine(theme, "accent", text), 0, 0);
		},

		renderResult(result, _options, theme) {
			const text = result.content[0];
			const msg = text?.type === "text" ? text.text : "";
			return new Text(outputLine(theme, "success", msg), 0, 0);
		},
	});

	registerToolWithExecutor(pi, {
		name: "dispatch_agents",
		label: "Dispatch Agents",
		description: "Dispatch one or more agents for the current pipeline phase. Agents run in parallel or sequential mode depending on the phase configuration. Use this in phases 2-5 to do the actual work. When reporting outcomes to the user: lead with results and next decisions; do not narrate internal mechanics (tabs, polling, journal ids, transport details).",
		parameters: Type.Object({
			agents: Type.Array(Type.Object({
				role: Type.String({ description: "Agent role name (e.g. 'scout', 'builder', 'reviewer')" }),
				task: Type.Optional(Type.String({ description: "Task description; defaults to the configured phase task_template" })),
			}), { description: "Array of agents to dispatch" }),
		}),

		execute: explicitDispatchHandler("pipeline-team", async (_toolCallId, params, signal, onUpdate, ctx) => {
			const { agents } = params as { agents: { role: string; task: string }[] };
			const phase = phaseStates[currentPhaseIndex];

			if (!phase) {
				return { content: [{ type: "text", text: "No active phase." }], details: {} };
			}
			if (phase.def.name.toLowerCase() === "review" && reviewLoopCount >= activeConfig.review_max_loops) {
				return { content: [{ type: "text", text: `Review loop limit reached (${activeConfig.review_max_loops}). Advance the pipeline or revise the configuration.` }], details: { error: true, phase: phase.def.name, reviewLoop: reviewLoopCount } };
			}
			if (phase.status === "active" && phase.lastDispatchSuccess) {
				return {
					content: [{ type: "text", text: `${phase.def.name.toUpperCase()} already has a successful dispatch. Call advance_phase with its bounded summary before dispatching it again.` }],
					details: { error: true, phase: phase.def.name, reason: "already_dispatched" },
				};
			}

			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: `Dispatching ${agents.length} agent(s) in ${phase.def.mode} mode...` }],
					details: { agents: agents.map(a => a.role), mode: phase.def.mode, status: "dispatching" },
				});
			}

			// Resolve template variables in task strings
			const requested = agents.length > 0 ? agents : phase.def.agents.map(a => ({ role: a.role, task: a.task_template }));
			const resolved = requested.map(a => ({
				role: a.role,
				task: resolveTemplate(a.task || "", {
					task: taskSummary,
					context: accContext,
					plan: planOutput,
					input: boundedHandoff(accContext || taskSummary),
					review: reviewOutput,
				}),
				...((a as any).resources ? { resources: (a as any).resources } : {}),
			}));

			const mode = phase.def.mode === "interactive" ? "sequential" : phase.def.mode;
			const orchestrationRun = createOrchestrationRun({
				context: ctx,
				signal,
				actor: `pipeline:${activeConfig.name}:phase:${phase.def.name}`,
				mode: "PIPELINE",
				budget: { maxSteps: Math.max(1, resolved.length) },
				workspaceCwd: ctx?.cwd,
			});
			orchestrationRun.record("pipeline.started", { phase: phase.def.name, mode, agents: resolved.map(a => ({ role: a.role, ...((a as any).resources ? { resources: (a as any).resources } : {}) })) });
			orchestrationRun.consumeStep();
			let result: Awaited<ReturnType<typeof dispatchPhaseAgents>>;
			try {
				result = await dispatchPhaseAgents(resolved, mode as "parallel" | "sequential", ctx, orchestrationRun.runId, orchestrationRun.signal, orchestrationRun);
				orchestrationRun.record("pipeline.completed", { phase: phase.def.name, success: result.success, agents: resolved.length });
				orchestrationRun.finish(result.success ? "succeeded" : "failed", { phase: phase.def.name });
			} catch (error) {
				orchestrationRun.record("pipeline.failed", { phase: phase.def.name, error: error instanceof Error ? error.message : String(error) });
				orchestrationRun.finish("failed", { phase: phase.def.name });
				return { content: [{ type: "text", text: `Pipeline dispatch failed: ${error instanceof Error ? error.message : String(error)}` }], details: { error: true, phase: phase.def.name, runId: orchestrationRun.runId } };
			}

			// Merge outputs into accumulated context. Each output is already a
			// compact precision-preserving index (## RESULT + full-output path),
			// so the accumulated context stays small without losing access.
			const mergedOutput = result.outputs.join("\n\n---\n\n");
			const mergedFull = result.fullOutputs.join("\n\n---\n\n");
			const mergedPaths = result.fullOutputPaths.filter(Boolean).join("\n");
			const outputSummary = mergedOutput.length > 3000
				? mergedOutput.slice(0, 3000) + "\n\n... [output truncated, full output was " + mergedOutput.length + " chars]"
				: mergedOutput;
			accContext = boundedHandoff(`## Phase ${currentPhaseIndex + 1} Agent Handoff\n${outputSummary}`);

			// Store plan output if this is the plan phase
			if (phase.def.name.toLowerCase() === "plan") {
				planOutput = mergedOutput;
				bindPipelinePlan(mergedOutput);
			}

			// Store review output if this is the review phase
			if (phase.def.name.toLowerCase() === "review") {
				reviewOutput = mergedOutput;
				reviewLoopCount++;
			}

			// mergedOutput is already composed (compact index + pointers); keep a
			// safety cap that never silently drops the pointer lines.
			const truncated = mergedOutput.length > 12000
				? mergedOutput.slice(0, 12000) + "\n\n... [output truncated at 12000 chars — full transcripts preserved on disk]"
				: mergedOutput;

			const status = result.success ? "done" : "error";
			phase.lastDispatchSuccess = result.success;
			// Persist the completed dispatch and accumulated handoff before
			// returning to the parent. If the parent restarts before advance_phase,
			// recovery can ask it to advance instead of repeating side effects.
			persistPipelineState();
			const blockedNotice = result.blockedReason ? `\n\n${result.blockedReason}` : "";

			return {
				content: [{ type: "text", text: `[${phase.def.name}] ${status} — ${agents.length} agent(s)${blockedNotice}\n\n${truncated}` }],
					details: {
						 runId: orchestrationRun.runId,
						phase: phase.def.name,
					agents: agents.map(a => a.role),
					status,
					outputPreview: boundedOutputPreview(mergedFull),
					fullOutputPath: mergedPaths,
					reviewLoop: reviewLoopCount,
				},
			};
		}) as any,


		renderCall(args, theme) {
			const agents = (args as any).agents || [];
			const roles = agents.map((a: any) => a.role).join(", ");
			const text =
				theme.fg("toolTitle", theme.bold("dispatch_agents ")) +
				theme.fg("accent", `${agents.length} agent(s)`) +
				theme.fg("dim", " — ") +
				theme.fg("muted", roles);
			return new Text(outputLine(theme, "accent", text), 0, 0);
		},

		renderResult(result, options, theme) {
			const details = result.details as any;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			const normalizedStatus = normalizeRunStatus(details.status || "done");
			if (options.isPartial || normalizedStatus === "running" || normalizedStatus === "queued") {
				const runningBtn = statusButton("active", details.phase || "?", theme);
				const content = runningBtn +
					theme.fg("dim", ` dispatching ${(details.agents || []).length} agents...`);
				return new Text(outputLine(theme, "accent", content), 0, 0);
			}

			const status = normalizedStatus === "succeeded" ? "done" : "error";
			const bar = status === "done" ? "success" : "error";
			const statusBtn = statusButton(status, details.phase, theme);
			const header = statusBtn +
				theme.fg("dim", ` ${(details.agents || []).length} agents`);

			if (options.expanded && details.outputPreview) {
				const output = details.outputPreview;
				const mdTheme = getPiMdTheme();
				const container = new Container();
				container.addChild(new Text(outputLine(theme, bar, header), 0, 0));
				container.addChild(new Markdown(output, 2, 0, mdTheme));
				return container;
			}

			return new Text(outputLine(theme, bar, header), 0, 0);
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

			const status = [
				`Pipeline: ${activeConfig.name}`,
				`Current Phase: ${phaseStates[currentPhaseIndex]?.def.name.toUpperCase() || "none"} (${currentPhaseIndex + 1}/${phaseStates.length})`,
				`Review Loops: ${reviewLoopCount}/${activeConfig.review_max_loops}`,
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

		renderCall(_args, theme) {
			return new Text(outputLine(theme, "accent", theme.bold("pipeline_status")), 0, 0);
		},

		renderResult(result, _options, theme) {
			const text = result.content[0];
			const msg = text?.type === "text" ? text.text : "";
			return new Text(outputLine(theme, "accent", msg), 0, 0);
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
			activeConfig = null;
			clearPipelineSnapshot(sessionDir);
			setActivePipeline(null);
			phaseStates = [];
			clearPipelineUI();
			ctx.ui.notify("Pipeline deactivated. Use /pipeline to select one.", "info");
		},
	});

	pi.registerCommand("pipeline-clear", {
		description: "Clear pipeline widget from screen (keeps pipeline active)",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;
			clearPipelineUI();

			// Reset agent states within each phase so the widget can reappear on next dispatch
			for (const ps of phaseStates) {
				for (const agent of ps.agents) {
					if (agent.status === "done" || agent.status === "error") {
						agent.status = "idle";
						agent.lastWork = "";
						agent.output = "";
						agent.elapsed = 0;
					}
				}
			}

			ctx.ui.notify("Pipeline widget cleared. Pipeline remains active.", "info");
		},
	});

		// ── /pipeline-grid command ────────────────────

	pi.registerCommand("pipeline-grid", {
		description: "Open agent grid overlay",
		handler: async (_args, ctx) => {
			const agents = collectOverlayAgents();
			if (agents.length === 0) {
				ctx.ui.notify("No agents to inspect", "info");
				return;
			}

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const overlay = new AgentGridOverlay(agents, () => done(undefined));
				return {
					render: (w) => overlay.render(w, 30, theme),
					handleInput: (data) => overlay.handleInput(data, tui),
					invalidate: () => {},
				};
			}, {
				overlay: true,
				overlayOptions: { width: "80%", anchor: "center" },
			});
		},
	});
;

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
		const phaseName = phase.def.name.toUpperCase();

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

		if (phase.def.name === "understand") {
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

		} else if (phase.def.name === "gather") {
			phaseInstructions = `## Phase Instructions: GATHER
				You are in the GATHER phase. Dispatch scout agents to explore the codebase in parallel. When the task needs current external facts, also dispatch one researcher in parallel. If no compatible web capability is available, record the gap and continue.
				Use \`dispatch_agents\` to send multiple scouts concurrently.
				${RESEARCH_ROUTING_PROMPT}
				Review their findings, then call \`advance_phase\` with a summary.

Default agents from config:
${phase.def.agents.map((a, i) => `${i + 1}. ${a.role}: ${a.task_template.slice(0, 100)}`).join("\n")}`;

		} else if (phase.def.name === "plan") {
			phaseInstructions = `## Phase Instructions: PLAN
You are in the PLAN phase. Dispatch a planner with \`dispatch_agents\` — do not write the plan yourself.
The planner's output must include a ## Contract section with executable assertions: [cmd] <command>, [file] <path>, or [match] <regex> :: <path>. Pipeline complete is refused without at least one executable assertion.
Wait for the planner's ## RESULT, then call \`advance_phase\` with that summary. The plan is stored as $PLAN.`;

		} else if (phase.def.name === "execute" || phase.def.name === "build") {
			phaseInstructions = `## Phase Instructions: ${phaseName}
Dispatch builder agents with \`dispatch_agents\`. Do not implement files yourself.
Wait for ## RESULT, then call \`advance_phase\`.`;

		} else if (phase.def.name === "review") {
			phaseInstructions = `## Phase Instructions: REVIEW
You are in the REVIEW phase (loop ${reviewLoopCount + 1}/${activeConfig.review_max_loops}).
Dispatch a reviewer agent to audit the implementation.
After reviewing the output:
- If the reviewer says APPROVED → call \`advance_phase\`. Completing still requires the ## Contract assertions to PASS deterministically, including plan-build pipelines whose last phase is build.
- If issues found and loops remaining → use \`dispatch_agents\` to fix issues, then review again
- Max review loops: ${activeConfig.review_max_loops}`;
		}

		return {
			systemPrompt: `You are orchestrating a pipeline called "${activeConfig.name}".

${ORCHESTRATED_TASK_PROMPT}

${RESEARCH_ROUTING_PROMPT}

You have full codebase tools AND pipeline tools (advance_phase, dispatch_agents, pipeline_status).

## Pipeline boundary (required)
- This is PIPELINE, not CHAIN. Never call run_chain, dispatch_agent, or subagent_create for pipeline work.
- Use only dispatch_agents for configured phase workers, then advance_phase after their RESULT returns.
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
- \`advance_phase\`: Move to next phase after this phase's dispatch_agents have finished (required summary from their RESULT)
- \`dispatch_agents\`: Send agents to work (array of {role, task})
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
					try { unlinkSync(join(sessDir, f)); } catch {}
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
						try { agent.proc.kill("SIGTERM"); } catch {}
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
					try { agent.proc.kill("SIGTERM"); } catch {}
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

	pi.on("session_switch", async (_event, ctx) => withSessionLifecycle(async () => {
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
					try { agent.proc.kill("SIGTERM"); } catch {}
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
