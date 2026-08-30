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
 *   /pipeline-status     — full pipeline state notification
 *   /pipeline-reset      — reset pipeline to phase 1
 *   /pipeline-clear      — clear pipeline widget from screen (keeps pipeline active)
 *   /pipeline-off       — deactivate pipeline and hide UI
 *
 * Usage: pi -e extensions/pipeline-team.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	Box, Text, Container, Spacer, Markdown,
	matchesKey, Key, truncateToWidth, visibleWidth,
} from "@mariozechner/pi-tui";
import { DynamicBorder, getMarkdownTheme as getPiMdTheme } from "@mariozechner/pi-coding-agent";
import { readLastAssistantText, sessionUsage, updateHerdrPaneStatus, registerHerdrCommands, herdrWorkerLabel } from "./lib/herdr-client.ts";
import { readFileSync, existsSync, readdirSync, mkdirSync, unlinkSync } from "fs";
import { join, resolve, basename, dirname } from "path";
import { fileURLToPath } from "url";
import { applyExtensionDefaults } from "./lib/themeMap.ts";
import { modePromptMatches } from "./lib/mode-cycler-logic.ts";
import { GRILL_ME_SECTION, ORCHESTRATED_TASK_PROMPT } from "./lib/mode-prompts.ts";
import { coordinationState, setActivePipeline, commanderAvailable as isCommanderAvailable, onCoordinationModeChange, setCoordinationMode } from "./lib/coordination-state.ts";
import { childEnvironment } from "./lib/child-runtime.ts";
import { subagentContextBudget } from "./lib/context-budget.ts";
import { outputLine, outputBox, type BarColor } from "./lib/output-box.ts";
import { renderVerticalTimeline, renderCollapsedTimeline, statusButton } from "./lib/pipeline-render.ts";
import { DEFAULT_SUBAGENT_MODEL } from "./lib/defaults.ts";
import { buildAgentResultContractPrompt, composeAgentResult, extractResultBlock, persistFullOutput, resultOneLiner, runBaseName } from "./lib/agent-result-contract.ts";
import { journalAppend, journalUpdate, pruneRunArtifacts, reconcileJournal, registerTaskStatusCommand } from "./lib/agent-task-journal.ts";
import { resolveToolkitWorkerModel } from "./lib/toolkit-cli.ts";
import { loadAgentModelsConfig, resolveAgentModelString, type AgentModelsConfig } from "./lib/agent-defs.ts";
import { parsePipelineYaml, phaseRequiresAgentDispatch, pipelineSelectLabel, type PhaseAgentDef, type PhaseDef, type PipelineConfig } from "./lib/parse-pipeline-yaml.ts";
import { currentDispatchAuthorization, explicitDispatchHandler, isExplicitDispatchActive, run as runDispatch, withSessionLifecycle } from "./lib/dispatch-runtime.ts";
import { matchNamedOption } from "./lib/named-pick.ts";
import { applyWorkerLaunchPolicy, implementationWorkerPrompt, isExecutionWorker, workerHitToolCap } from "./lib/worker-budget.ts";
import { objectiveHash, type GoalContract } from "./lib/execution-contract.ts";
import { recordEvidence, recordRunEvent } from "./lib/evidence-store.ts";
import { buildVerifierPrompt, canComplete, createVerifierReceipt, parseVerifierStatus, workspaceHash, type VerifierReceipt } from "./lib/verifier-runtime.ts";
import { verifierAction, DEFAULT_VERIFIER_ATTEMPTS } from "./lib/verification-policy.ts";
import { initializeRun, saveGoal, saveVerifierReceipt } from "./lib/execution-run.ts";
import { createBuilderWorktree, applyWorktreeDiff, type WorktreeRef } from "./lib/worktree.ts";
import { execFileSync } from "node:child_process";

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

	// Accumulated context across phases
	let taskSummary = "";   // $TASK — from phase 1
	let accContext = "";     // $CONTEXT — accumulated from all phases
	let planOutput = "";     // $PLAN — from phase 3
	let reviewOutput = "";   // $REVIEW — from phase 5 (when looping)
	let reviewLoopCount = 0;
	let executionGoal: GoalContract | undefined;
	let verifierReceipt: VerifierReceipt | undefined;
	let verifierAttempt = 0;

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
		executionGoal = undefined;
		verifierReceipt = undefined;
		verifierAttempt = 0;

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
		agentState.timer = setInterval(() => {
			agentState.elapsed = Date.now() - startTime;
			updateWidget();
		}, 1000);

		// Use agent's defined model or fall back to default subagent model.
		// NOTE: We intentionally do NOT inherit the parent model. Each agent
		// should use its explicitly defined model or the lightweight default.
		const model = resolveToolkitWorkerModel(agentDef.name, agentDef.model || DEFAULT_SUBAGENT_MODEL);

		const agentKey = `pipeline-${agentDef.name.toLowerCase().replace(/\s+/g, "-")}-${agentState.index}`;
		const agentSessionFile = join(sessionDir, `${agentKey}.json`);
		let workerCwd = ctx.cwd;
		let workerWorktree: WorktreeRef | undefined;
		if (process.env.PI_PIPELINE_WORKTREES === "1" && isExecutionWorker(agentDef.name)) {
			try {
				workerWorktree = createBuilderWorktree(ctx.cwd, join(sessionDir, "worktrees"), `${agentKey}-${Date.now().toString(36)}`);
				workerCwd = workerWorktree.path;
			} catch (error) {
				return Promise.resolve({ output: `Worktree creation failed: ${error instanceof Error ? error.message : String(error)}`, fullOutput: "", fullOutputPath: "", exitCode: 1, elapsed: 0 });
			}
		}

		const extDir = dirname(fileURLToPath(import.meta.url));
		const securityGuardExtPath = join(extDir, "security-guard.ts");
		const tasksExtPath = join(extDir, "tasks.ts");
		const askParentExtPath = join(extDir, "ask-parent.ts");
		const footerExtPath = join(extDir, "footer.ts");
		const memoryCycleExtPath = join(extDir, "memory-cycle.ts");
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
			task,
			model,
			cwd: workerCwd,
			sessionFile: hasSession ? agentSessionFile : undefined,
			resumed: !!hasSession,
			status: "dispatched",
			startedAt: Date.now(),
			updatedAt: Date.now(),
		});

		const args = [
			"--mode", "json",
			"-p",
			"--no-extensions",
			"-e", securityGuardExtPath,
			"-e", tasksExtPath,
			"-e", footerExtPath,
			"-e", memoryCycleExtPath,
			"-e", askParentExtPath,
			"--model", model,
			"--tools", agentDef.tools,
			"--append-system-prompt", agentDef.systemPrompt + buildAgentResultContractPrompt() + (isExecutionWorker(agentDef.name) ? implementationWorkerPrompt() : ""),
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
				clearInterval(agentState.timer);
				agentState.proc = null;
				agentState.elapsed = Date.now() - startTime;
				updateHerdrPaneStatus(ctx.cwd, journalId, code === 0 ? "done" : "error");
				let output = externalFull ?? textChunks.join("");
				if (code === 0 && workerWorktree) {
					try { applyWorktreeDiff(workerWorktree, ctx.cwd); }
					catch (error) { code = 1; output += `\nWorktree merge failed: ${error instanceof Error ? error.message : String(error)}`; }
				}
				if (executionGoal && sessionDir) {
					try { recordEvidence(join(sessionDir, "execution-runs", executionGoal.id), { id: `${executionGoal.id}-${journalId}-claim`, type: "review", source: "worker_claim", value: output.slice(0, 12000), timestamp: new Date().toISOString() }); } catch {}
				}
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
					composed = composeAgentResult({
						agent: agentDef.name,
						status: agentState.status,
						exitCode: code,
						elapsedMs: agentState.elapsed,
						model,
						outputText: output,
						fullOutputPath,
						maxResultChars: subagentContextBudget(ctx?.getContextUsage?.()?.percent, 1).resultChars,
					}).content;
				} catch {
					composed = output; // persistence failure must never lose the result itself
					fullOutputPath = "";
				}

				const pu = agentSessionFile && code === 0 ? sessionUsage(agentSessionFile) : null;
				journalUpdate(sessionDir, journalId, {
					status: agentState.status,
					exitCode: code,
					elapsedMs: agentState.elapsed,
					sessionFile: code === 0 ? agentSessionFile : undefined,
					outputFile: fullOutputPath || undefined,
					usage: pu && pu.assistantMessages > 0 ? {
						input: pu.input, output: pu.output, cacheRead: pu.cacheRead, cacheWrite: pu.cacheWrite,
						totalTokens: pu.totalTokens, costUsd: Math.round(pu.costUsd * 1e6) / 1e6,
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
				}),
				launchDir: sessionDir,
				launchId: journalId,
				sessionFile: agentSessionFile,
				herdrDoneExtPath,
				herdrLabel: herdrWorkerLabel(agentDef?.name || "pipeline", journalId),
				herdrPaneKey: journalId,
				journal: { dir: sessionDir, id: journalId },
				onProcess: (child) => { agentState.proc = child as any; },
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
		agentDefs: { role: string; task: string }[],
		mode: "parallel" | "sequential",
		ctx: any,
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
				return spawnAgent(def, d.task, phaseState.agents[i], ctx);
			};
			// Bounded fan-out: at most maxParallel agents run at once (env-tunable),
			// so a 12-agent phase cannot spike to 12 simultaneous pi processes.
			const results: Array<Awaited<ReturnType<typeof spawnAgent>>> = [];
			let cursor = 0;
			const workers = Array.from({ length: Math.min(maxParallel, agentDefs.length) }, async () => {
				while (cursor < agentDefs.length) {
					const i = cursor++;
					results[i] = await launch(agentDefs[i], i);
				}
			});
			await Promise.all(workers);
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
				const result = await spawnAgent(def, task, phaseState.agents[i], ctx);
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

	// ── Execution contract / verifier ─────────────
	function ensureExecutionGoal(summary: string): GoalContract {
		if (executionGoal) return executionGoal;
		const id = `pipeline-${Date.now().toString(36)}`;
		executionGoal = {
			version: 1,
			id,
			objective: summary.trim() || "Complete the active pipeline",
			scope: [],
			constraints: [],
			successCriteria: ["All configured pipeline phases complete", "Relevant verification commands pass"],
			evidenceRequired: [
				{ id: "git-diff", description: "Inspect the final repository diff", type: "diff" },
				{ id: "verification", description: "Run the relevant verification commands", type: "test" },
			],
			risks: [],
			subgoals: [],
			status: "running",
		};
		if (sessionDir) {
			try { initializeRun(join(sessionDir, "execution-runs"), executionGoal); } catch {}
		}
		return executionGoal;
	}

	function collectPipelineDiff(cwd: string): string {
		try {
			return execFileSync("git", ["diff", "--no-ext-diff", "--", "."], { cwd, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
		} catch { return "Unable to collect git diff"; }
	}

	async function runPipelineVerifier(ctx: any, summary: string): Promise<{ receipt?: VerifierReceipt; error?: string }> {
		const goal = ensureExecutionGoal(summary);
		if (sessionDir) { try { saveGoal(join(sessionDir, "execution-runs", goal.id), goal); } catch {} }
		const diff = collectPipelineDiff(ctx.cwd);
		let changedFiles: string[] = [];
		try { changedFiles = execFileSync("git", ["diff", "--name-only", "--no-ext-diff"], { cwd: ctx.cwd, encoding: "utf8" }).split("\n").filter(Boolean); } catch {}
		const evidence = [
			{ id: `${goal.id}-diff`, type: "diff" as const, source: "runtime" as const, value: diff.slice(0, 12000), timestamp: new Date().toISOString() },
			{ id: `${goal.id}-files`, type: "file" as const, source: "runtime" as const, value: JSON.stringify(changedFiles), timestamp: new Date().toISOString() },
		];
		if (sessionDir) {
			try { recordEvidence(join(sessionDir, "execution-runs", goal.id), evidence[0]); recordEvidence(join(sessionDir, "execution-runs", goal.id), evidence[1]); } catch {}
		}
		const prompt = buildVerifierPrompt({ goal, evidence, diff, workerSummary: summary });
		const extDir = dirname(fileURLToPath(import.meta.url));
		const verifierModel = allAgents.get("reviewer")?.model || allAgents.get("warden")?.model || "";
		const args = ["--mode", "json", "-p", "--no-extensions", "-e", join(extDir, "security-guard.ts"), "--tools", "read,grep,find,ls", ...(verifierModel ? ["--model", verifierModel] : []), prompt];
		const output: string[] = [];
		const auth = currentDispatchAuthorization();
		if (!auth) return { error: "Verifier requires an explicit pipeline dispatch authorization" };
		const result = await runDispatch({
			authorization: auth,
			command: ["pi", ...args],
			cwd: ctx.cwd,
			env: childEnvironment({ PI_SUBAGENT: "1", PI_AGENT_NAME: "reviewer-verifier" }),
			launchDir: sessionDir,
			launchId: `${goal.id}-verifier-${verifierAttempt + 1}`,
			transport: "headless",
			pollTimeoutMs: 15 * 60 * 1000,
			onStdoutLine: (line) => {
				try {
					const event = JSON.parse(line);
					const delta = event.assistantMessageEvent?.delta;
					if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") output.push(delta || "");
				} catch {}
			},
		});
		const text = result.outputText || output.join("");
		const status = parseVerifierStatus(text);
		if (result.exitCode !== 0 || !status) return { error: result.stderr || "Verifier returned no unambiguous decision" };
		const receipt = createVerifierReceipt({ output: text, objectiveHash: objectiveHash(goal), criteria: goal.successCriteria.map(criterion => ({ criterion, status: status === "PASS" ? "pass" : "unknown", evidenceIds: [evidence[0].id, evidence[1].id], note: text.slice(-1200) })), commandsRun: ["git diff --no-ext-diff -- .", "git diff --name-only --no-ext-diff"], changedFiles, workspaceHash: workspaceHash(diff, changedFiles), attempt: verifierAttempt + 1, verifierModel });
		if (!receipt) return { error: "Could not construct verifier receipt" };
		if (sessionDir) {
			const runDir = join(sessionDir, "execution-runs", goal.id);
			try { saveVerifierReceipt(runDir, receipt); recordRunEvent(runDir, { id: `${goal.id}-verify-${verifierAttempt + 1}`, type: status === "PASS" ? "verification_passed" : "verification_failed", actor: "reviewer-verifier", timestamp: new Date().toISOString(), payload: receipt }); } catch {}
		}
		return { receipt };
	}

	// ── Tools ────────────────────────────────────

	pi.registerTool({
		name: "advance_phase",
		label: "Advance Phase",
		description: "Move the pipeline to the next phase after the current phase's work is done. UNDERSTAND may advance without dispatch. PLAN/BUILD/GATHER/EXECUTE/REVIEW require dispatch_agents first — do not advance on a self-written summary.",
		parameters: Type.Object({
			summary: Type.String({ description: "Summary of what was accomplished in this phase / the clarified task" }),
			skip_to: Type.Optional(Type.String({ description: "Optional: skip to a specific phase name (e.g. 'plan' to skip gather)" })),
		}),

		execute: explicitDispatchHandler("pipeline-team", (async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
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

			// Mark current phase done
			phaseStates[currentPhaseIndex].status = "done";
			phaseStates[currentPhaseIndex].summary = summary;
			// Capture the user-facing objective early, then refine acceptance criteria
			// from the PLAN phase. These fields are persisted separately from UI text.
			const phaseName = current.def.name.toLowerCase();
			if (phaseName === "understand" || phaseName === "gather") ensureExecutionGoal(summary);
			if (phaseName === "plan" && executionGoal) {
				const criteria = summary.split("\n").map(line => line.replace(/^[-*]\s*(?:\[[ x]\])?\s*/, "").trim()).filter(line => line.length >= 8).slice(0, 12);
				if (criteria.length > 0) executionGoal.successCriteria = criteria;
				if (sessionDir) { try { saveGoal(join(sessionDir, "execution-runs", executionGoal.id), executionGoal); } catch {} }
			}

			// Accumulate context
			if (currentPhaseIndex === 0) {
				taskSummary = summary;
			}
			accContext += `\n\n## Phase ${currentPhaseIndex + 1}: ${phaseStates[currentPhaseIndex].def.name}\n${summary}`;

			// Determine next phase
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
				if (current.def.name.toLowerCase() === "review") {
					verifierAttempt++;
					const verification = await runPipelineVerifier(_ctx, summary);
					if (verification.receipt) {
						verifierReceipt = verification.receipt;
						const action = verifierAction(verification.receipt.status, verifierAttempt, DEFAULT_VERIFIER_ATTEMPTS, verification.receipt.status !== "BLOCKED");
						if (!canComplete(verification.receipt, objectiveHash(executionGoal), workspaceHash(collectPipelineDiff(_ctx.cwd), verification.receipt.changedFiles)) || action !== "complete") {
							if (action === "retry") {
								// Keep the same run alive and return to EXECUTE. The next
								// dispatch receives the verifier output instead of silently
								// starting a disconnected new workflow.
								const executeIndex = phaseStates.findIndex(p => /^(execute|build)$/i.test(p.def.name));
								if (executeIndex >= 0) {
									phaseStates[currentPhaseIndex].status = "pending";
									phaseStates[executeIndex].status = "active";
									phaseStates[executeIndex].summary = `Verifier feedback (attempt ${verifierAttempt}): ${verification.receipt.criteria.map(c => c.note || `${c.criterion}: ${c.status}`).join("; ")}`;
									currentPhaseIndex = executeIndex;
									updateWidget();
									return { content: [{ type: "text", text: `Verifier FAIL (attempt ${verifierAttempt}/${DEFAULT_VERIFIER_ATTEMPTS}). Returned to EXECUTE; dispatch a builder with the verifier feedback.` }], details: { phase: "execute", verifier: verification.receipt } };
								}
								return { content: [{ type: "text", text: "Verifier FAIL, but no EXECUTE phase is configured. Human intervention required." }], details: { phase: "verification", verifier: verification.receipt } };
							}
							return { content: [{ type: "text", text: `Verifier ${verification.receipt.status}. Human review required before completion.` }], details: { phase: "verification", verifier: verification.receipt } };
						}
					} else {
						return { content: [{ type: "text", text: `Verifier could not complete: ${verification.error || "unknown error"}` }], details: { error: true, phase: "verification" } };
					}
				}
				activeConfig = null;
				updateWidget();
				return {
					content: [{ type: "text", text: "Pipeline complete! All phases finished." }],
					details: { phase: "complete", summary },
				};
			}

			currentPhaseIndex = nextIndex;
			phaseStates[currentPhaseIndex].status = "active";
			updateWidget();

			const phase = phaseStates[currentPhaseIndex].def;
			return {
				content: [{ type: "text", text: `Advanced to phase: ${phase.name.toUpperCase()} — ${phase.description}\nMode: ${phase.mode}\nAgents: ${phase.agents.length}` }],
				details: { phase: phase.name, mode: phase.mode },
			};
		}) as any),

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

	pi.registerTool({
		name: "dispatch_agents",
		label: "Dispatch Agents",
		description: "Dispatch one or more agents for the current pipeline phase. Agents run in parallel or sequential mode depending on the phase configuration. Use this in phases 2-5 to do the actual work. When reporting outcomes to the user: lead with results and next decisions; do not narrate internal mechanics (tabs, polling, journal ids, transport details).",
		parameters: Type.Object({
			agents: Type.Array(Type.Object({
				role: Type.String({ description: "Agent role name (e.g. 'scout', 'builder', 'reviewer')" }),
				task: Type.Optional(Type.String({ description: "Task description; defaults to the configured phase task_template" })),
			}), { description: "Array of agents to dispatch" }),
		}),

		execute: explicitDispatchHandler("pipeline-team", (async (_toolCallId, params, _signal, onUpdate, ctx) => {
			const { agents } = params as { agents: { role: string; task: string }[] };
			const phase = phaseStates[currentPhaseIndex];

			if (!phase) {
				return { content: [{ type: "text", text: "No active phase." }], details: {} };
			}
			if (phase.def.name.toLowerCase() === "review" && reviewLoopCount >= activeConfig.review_max_loops) {
				return { content: [{ type: "text", text: `Review loop limit reached (${activeConfig.review_max_loops}). Advance the pipeline or revise the configuration.` }], details: { error: true, phase: phase.def.name, reviewLoop: reviewLoopCount } };
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
					input: "$INPUT",
					review: reviewOutput,
				}),
			}));

			const mode = phase.def.mode === "interactive" ? "sequential" : phase.def.mode;
			const result = await dispatchPhaseAgents(resolved, mode as "parallel" | "sequential", ctx);

			// Merge outputs into accumulated context. Each output is already a
			// compact precision-preserving index (## RESULT + full-output path),
			// so the accumulated context stays small without losing access.
			const mergedOutput = result.outputs.join("\n\n---\n\n");
			const mergedFull = result.fullOutputs.join("\n\n---\n\n");
			const mergedPaths = result.fullOutputPaths.filter(Boolean).join("\n");
			const outputSummary = mergedOutput.length > 3000
				? mergedOutput.slice(0, 3000) + "\n\n... [output truncated, full output was " + mergedOutput.length + " chars]"
				: mergedOutput;
			accContext += `\n\n## Phase ${currentPhaseIndex + 1} Agent Output:\n${outputSummary}`;

			// Store plan output if this is the plan phase
			if (phase.def.name.toLowerCase() === "plan") {
				planOutput = mergedOutput;
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
			const blockedNotice = result.blockedReason ? `\n\n${result.blockedReason}` : "";

			return {
				content: [{ type: "text", text: `[${phase.def.name}] ${status} — ${agents.length} agent(s)${blockedNotice}\n\n${truncated}` }],
				details: {
					phase: phase.def.name,
					agents: agents.map(a => a.role),
					status,
					fullOutput: mergedFull,
					fullOutputPath: mergedPaths,
					reviewLoop: reviewLoopCount,
				},
			};
		}) as any),

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

			if (options.isPartial || details.status === "dispatching") {
				const runningBtn = statusButton("active", details.phase || "?", theme);
				const content = runningBtn +
					theme.fg("dim", ` dispatching ${(details.agents || []).length} agents...`);
				return new Text(outputLine(theme, "accent", content), 0, 0);
			}

			const status = details.status === "done" ? "done" : "error";
			const bar = status === "done" ? "success" : "error";
			const statusBtn = statusButton(status, details.phase, theme);
			const header = statusBtn +
				theme.fg("dim", ` ${(details.agents || []).length} agents`);

			if (options.expanded && details.fullOutput) {
				const output = details.fullOutput.length > 4000
					? details.fullOutput.slice(0, 4000) + "\n... [truncated]"
					: details.fullOutput;
				const mdTheme = getPiMdTheme();
				const container = new Container();
				container.addChild(new Text(outputLine(theme, bar, header), 0, 0));
				container.addChild(new Markdown(output, 2, 0, mdTheme));
				return container;
			}

			return new Text(outputLine(theme, bar, header), 0, 0);
		},
	});

	pi.registerTool({
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
You are in the GATHER phase. Dispatch scout agents to explore the codebase in parallel.
Use \`dispatch_agents\` to send multiple scouts concurrently.
Review their findings, then call \`advance_phase\` with a summary.

Default agents from config:
${phase.def.agents.map((a, i) => `${i + 1}. ${a.role}: ${a.task_template.slice(0, 100)}`).join("\n")}`;

		} else if (phase.def.name === "plan") {
			phaseInstructions = `## Phase Instructions: PLAN
You are in the PLAN phase. Dispatch a planner with \`dispatch_agents\` — do not write the plan yourself.
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
- If the reviewer says APPROVED → call \`advance_phase\` to complete the pipeline
- If issues found and loops remaining → use \`dispatch_agents\` to fix issues, then review again
- Max review loops: ${activeConfig.review_max_loops}`;
		}

		const commanderAvailable = isCommanderAvailable();
		const commanderSection = commanderAvailable ? `

## Commander Integration (REQUIRED)
Commander is connected. ALWAYS use these tools for dashboard visibility:
- \`commander_session { operation: "file:open", file_path: <path> }\` — display key files in Commander's floating viewer
- \`commander_task\` — track tasks in the Commander dashboard
- \`commander_mailbox\` — send status updates to the dashboard

### Mailbox Protocol
- Check your inbox periodically: \`commander_mailbox { operation: "inbox", agent_name: "coordinator" }\`
- Send status at start, milestones, and completion
- Warm, professional, collaborative tone — no emojis anywhere
- Use file:open to show pipeline plans, phase results, or review reports` : "";

		return {
			systemPrompt: `You are orchestrating a pipeline called "${activeConfig.name}".

${ORCHESTRATED_TASK_PROMPT}

You have full codebase tools AND pipeline tools (advance_phase, dispatch_agents, pipeline_status).

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
- Plus all standard codebase tools (read, write, edit, bash, etc.)${commanderSection}`,
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

		// Wipe pipeline session files
		const sessDir = join(_ctx.cwd, ".pi", "agent-sessions");
		if (existsSync(sessDir)) {
			for (const f of readdirSync(sessDir)) {
				if (f.startsWith("pipeline-") && f.endsWith(".json")) {
					try { unlinkSync(join(sessDir, f)); } catch {}
				}
			}
		}

		loadConfig(_ctx.cwd);

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
}
