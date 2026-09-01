// ABOUTME: Sequential pipeline orchestrator that chains agent steps with prompt templates.
// ABOUTME: Each step's output feeds into the next via $INPUT; provides run_chain tool and /chain command.
/**
 * Agent Chain — Sequential pipeline orchestrator
 *
 * Runs opinionated, repeatable agent workflows. Chains are defined in
 * .pi/agents/agent-chain.yaml — each chain is a sequence of agent steps
 * with prompt templates. The user's original prompt flows into step 1,
 * the output becomes $INPUT for step 2's prompt template, and so on.
 * $ORIGINAL is always the user's original prompt.
 *
 * The primary Pi agent has NO codebase tools — it can ONLY kick off the
 * pipeline via the `run_chain` tool. On boot you select a chain; the
 * agent decides when to run it based on the user's prompt.
 *
 * Agents maintain session context within a Pi session — re-running the
 * chain lets each agent resume where it left off.
 *
 * Commands:
 *   /chain             — switch active chain
 *   /chain-list        — list all available chains
 *   /chain-clear       — clear chain widget from screen
 *
 * Usage: pi -e extensions/agent-chain.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerToolWithExecutor } from "./lib/tool-executor-registry.ts";
import { Type } from "@sinclair/typebox";
import { Text, visibleWidth, truncateToWidth, Container, Spacer, Markdown, matchesKey, Key, type AutocompleteItem } from "@mariozechner/pi-tui";
import { DynamicBorder, getMarkdownTheme as getPiMdTheme } from "@mariozechner/pi-coding-agent";
import { readLastAssistantText, sessionUsage, updateHerdrPaneStatus, registerHerdrCommands, herdrWorkerLabel } from "./lib/herdr-client.ts";
import { readFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { applyExtensionDefaults } from "./lib/themeMap.ts";
import { modePromptMatches } from "./lib/mode-cycler-logic.ts";
import { GRILL_ME_SECTION, ORCHESTRATED_TASK_PROMPT, RESEARCH_ROUTING_PROMPT } from "./lib/mode-prompts.ts";
import { coordinationState, setActiveChain, commanderAvailable as isCommanderAvailable, onCoordinationModeChange } from "./lib/coordination-state.ts";
import { childEnvironment, ensurePiTool } from "./lib/child-runtime.ts";
import { subagentContextBudget } from "./lib/context-budget.ts";
import { outputLine } from "./lib/output-box.ts";
import { statusButton } from "./lib/pipeline-render.ts";
import { DEFAULT_SUBAGENT_MODEL } from "./lib/defaults.ts";
import { buildAgentResultContractPrompt, composeAgentResult, extractResultBlock, persistFullOutput, resultOneLiner, runBaseName } from "./lib/agent-result-contract.ts";
import { journalAppend, journalUpdate, pruneRunArtifacts, reconcileJournal, registerTaskStatusCommand } from "./lib/agent-task-journal.ts";
import { loadExplicitAgentModelsConfig, resolveAgentModelString, type AgentModelsConfig } from "./lib/agent-defs.ts";
import { providerModelString, resolveInheritedModel } from "./lib/model-inheritance.ts";
import { parseChainYaml, type ChainStep, type ChainDef } from "./lib/parse-chain-yaml.ts";
import { matchNamedOption } from "./lib/named-pick.ts";
import { applyWorkerLaunchPolicy, implementationWorkerPrompt, isExecutionWorker, workerHitToolCap } from "./lib/worker-budget.ts";
import { discoverResearchTools } from "./lib/research-protocol.ts";
import { currentDispatchAuthorization, isExplicitDispatchActive, run as runDispatch, explicitDispatchHandler, withSessionLifecycle } from "./lib/dispatch-runtime.ts";

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

// ── Display Name Helper ──────────────────────────

function displayName(name: string): string {
	return name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
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
			const entry = modelsConfig.agents[key] || modelsConfig.default;
			if (entry?.model) {
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
			const scan = (d: string) => {
				for (const file of readdirSync(d, { withFileTypes: true })) {
					const fullPath = resolve(d, file.name);
					if (file.isDirectory()) {
						scan(fullPath);
					} else if (file.name.endsWith(".md")) {
						const def = parseAgentFile(fullPath, modelsConfig);
						if (def && !agents.has(def.name.toLowerCase())) {
							agents.set(def.name.toLowerCase(), def);
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
	let selectedStepIndex = -1;

	// Track the currently running chain subprocess for cancellation
	let currentChainProc: any = null;

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
			const work = state.lastWork.length > maxWork
				? state.lastWork.slice(0, maxWork - 3) + "..."
				: state.lastWork;
			lines.push(theme.fg("dim", " \u2502") + "  " + theme.fg("muted", work));
		}
		if (state.status === "pending" && state.description) {
			const prefix = "    ";
			const maxDesc = width - prefix.length - 1;
			const desc = state.description.length > maxDesc
				? state.description.slice(0, maxDesc - 3) + "..."
				: state.description;
			lines.push("    " + theme.fg("dim", desc));
		}
		return lines;
	}

	function hideChainWidget(ctx?: { ui?: { setWidget: (key: string, renderer: unknown) => void } }) {
		const ui = ctx?.ui || widgetCtx?.ui;
		try { ui?.setWidget("agent-chain", undefined); } catch {}
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
		widgetCtx.ui.setWidget("agent-chain", (_tui: any, theme: any) => {
			const text = new Text("", 0, 1);

			return {
				render(width: number): string[] {
					if (!activeChain || stepStates.length === 0) {
						text.setText(theme.fg("dim", "No chain active. Use /chain to select one."));
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

	// ── Run Agent (subprocess) ──────────────────

	function runAgent(
		agentDef: AgentDef,
		task: string,
		stepIndex: number,
		ctx: any,
	): Promise<{ output: string; fullOutput: string; fullOutputPath: string; exitCode: number; elapsed: number }> {
		if (!isExplicitDispatchActive()) {
			return Promise.resolve({ output: "Dispatch refused: only an explicit tool or slash command may start a child", fullOutput: "", fullOutputPath: "", exitCode: 126, elapsed: 0 });
		}
		ctx?.ui?.notify?.(`${agentDef.name} started`, "info");
		// Explicit project/user/frontmatter routing wins. Otherwise preserve the
		// provider/model that launched the parent Pi session.
		const model = resolveInheritedModel(
			agentDef.model,
			launchModel || providerModelString(ctx.model),
			DEFAULT_SUBAGENT_MODEL,
		);

		const agentKey = agentDef.name.toLowerCase().replace(/\s+/g, "-");
		const agentSessionFile = join(sessionDir, `chain-${agentKey}.json`);
		const hasSession = agentSessions.get(agentKey);

		const extDir = dirname(fileURLToPath(import.meta.url));
		// Loaded only by the visible herdr transport: writes the pane's done
		// marker on the child's first agent_end (an interactive worker stays alive).
		const herdrDoneExtPath = join(extDir, "herdr-done.ts");
		// Durable journal record — survives parent restarts (see /agents-status).
		const journalId = runBaseName(`chain-${agentKey}`, stepIndex + 1);
		journalAppend(sessionDir, {
			version: 1,
			id: journalId,
			kind: "chain",
			agent: agentDef.name,
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
			"--append-system-prompt", agentDef.systemPrompt + buildAgentResultContractPrompt() + (isExecutionWorker(agentDef.name) ? implementationWorkerPrompt() : ""),
			"--session", agentSessionFile,
		];

		if (hasSession) {
			args.push("-c");
		}

		args.push(task);

		const textChunks: string[] = [];
		let liveText = "";
		const startTime = Date.now();
		const state = stepStates[stepIndex];

		return new Promise((resolve) => {
			const timer = setInterval(() => {
				state.elapsed = Date.now() - startTime;
				updateWidget();
			}, 1000);

			// Shared completion path for both transports. Persist the FULL
			// transcript on disk, then compose the compact but complete
			// result index for the parent context / next step.
			const finish = (code: number | null, externalFull?: string) => {
				clearInterval(timer);
				currentChainProc = null;
				updateHerdrPaneStatus(ctx.cwd, journalId, code === 0 ? "done" : "error");

				const elapsed = Date.now() - startTime;
				state.elapsed = elapsed;
				const output = externalFull ?? textChunks.join("");
				state.lastWork = resultOneLiner(output, extractResultBlock(output).result) || "";

				if (code === 0) {
					agentSessions.set(agentKey, agentSessionFile);
				}

				let fullOutputPath = "";
				let composed = output;
				try {
					fullOutputPath = persistFullOutput(sessionDir, runBaseName(`chain-${agentKey}`, stepIndex + 1), output);
					composed = composeAgentResult({
						agent: agentDef.name,
						status: code === 0 ? "done" : "error",
						exitCode: code,
						elapsedMs: elapsed,
						model,
						outputText: output,
						fullOutputPath,
						maxResultChars: subagentContextBudget(ctx?.getContextUsage?.()?.percent, 1).resultChars,
					}).content;
				} catch {
					composed = output; // persistence failure must never lose the result itself
					fullOutputPath = "";
				}

				state.lastWork = resultOneLiner(output, extractResultBlock(output).result) || state.lastWork;

				const su = agentSessionFile && code === 0 ? sessionUsage(agentSessionFile) : null;
				journalUpdate(sessionDir, journalId, {
					status: code === 0 ? "done" : "error",
					exitCode: code,
					elapsedMs: elapsed,
					sessionFile: code === 0 ? agentSessionFile : undefined,
					outputFile: fullOutputPath || undefined,
					usage: su && su.assistantMessages > 0 ? {
						input: su.input, output: su.output, cacheRead: su.cacheRead, cacheWrite: su.cacheWrite,
						totalTokens: su.totalTokens, costUsd: Math.round(su.costUsd * 1e6) / 1e6,
					} : undefined,
				});

				resolve({ output: composed, fullOutput: output, fullOutputPath, exitCode: code ?? 1, elapsed });
			};

			// Transport mechanics live in one runtime. This caller keeps only
			// chain-specific parsing and widget state.
			const launch = applyWorkerLaunchPolicy(["pi", ...args], agentDef.name);
			const runtimePromise = runDispatch({
				authorization: currentDispatchAuthorization(),
				command: launch.command,
				cwd: ctx.cwd,
				env: childEnvironment({
					PI_SUBAGENT: "1",
					PI_AGENT_NAME: String(agentDef?.name || "").toLowerCase(),
					PI_PANE_TITLE: herdrWorkerLabel(agentDef?.name || "chain", journalId),
					PI_SESSION_FILE: agentSessionFile || undefined,
				}),
				launchDir: sessionDir,
				launchId: journalId,
				sessionFile: agentSessionFile,
				herdrDoneExtPath,
				herdrLabel: herdrWorkerLabel(agentDef?.name || "chain", journalId),
				herdrPaneKey: journalId,
				journal: { dir: sessionDir, id: journalId },
				onProcess: (child) => { currentChainProc = child; },
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
								state.lastWork = last;
								updateWidget();
							}
						} else if (event.type === "tool_execution_start") {
							state.toolCount = (state.toolCount || 0) + 1;
							if (workerHitToolCap(agentDef.name, state.toolCount) && currentChainProc) {
								try { currentChainProc.kill("SIGTERM"); } catch {}
								state.lastWork = "stopped: tool-call cap";
							}
						}
					} catch {}
				},
				onHerdrUpdate: () => {
					try {
						const { text } = readLastAssistantText(agentSessionFile);
						const last = text.split("\n").filter((l: string) => l.trim()).pop() || "";
						if (last) {
							state.lastWork = last;
							updateWidget();
						}
					} catch {}
				},
			});
			runtimePromise.then((result) => {
				finish(result.exitCode, result.outputText);
			}).catch(() => finish(1));

		});
	}

	// ── Run Chain (sequential pipeline) ─────────

	async function runChain(
		task: string,
		ctx: any,
	): Promise<{ output: string; fullOutput: string; fullOutputPath: string; success: boolean; elapsed: number }> {
		if (!isExplicitDispatchActive()) {
			return { output: "Dispatch refused: only an explicit tool or slash command may start a child", fullOutput: "", fullOutputPath: "", success: false, elapsed: 0 };
		}
		if (!activeChain) {
			return { output: "No chain active", fullOutput: "", fullOutputPath: "", success: false, elapsed: 0 };
		}

		const chainStart = Date.now();

		// Reset all steps to pending
		selectedStepIndex = -1;
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

		let input = task;
		const originalPrompt = task;
		const stepOutputs: string[] = [];
		let lastFullOutput = "";
		let lastFullOutputPath = "";

		for (let i = 0; i < activeChain.steps.length; i++) {
			const step = activeChain.steps[i];
			stepStates[i].status = "running";
			updateWidget();

			// Resolve prompt: $INPUT (previous step), $ORIGINAL (original task), $INPUT_N (step N output, 1-indexed)
			let resolvedPrompt = step.prompt
				.replace(/\$ORIGINAL/g, originalPrompt)
				.replace(/\$INPUT/g, input);
			
			// Replace $INPUT_N with stepOutputs[N-1] (1-indexed)
			resolvedPrompt = resolvedPrompt.replace(/\$INPUT_(\d+)/g, (_, n) => {
				const stepIndex = parseInt(n, 10) - 1;
				return stepIndex >= 0 && stepIndex < stepOutputs.length ? stepOutputs[stepIndex] : "";
			});

			const agentDef = allAgents.get(step.agent.toLowerCase());
			if (!agentDef) {
				stepStates[i].status = "error";
				stepStates[i].lastWork = `Agent "${step.agent}" not found`;
				updateWidget();
				return {
					output: `Error at step ${i + 1}: Agent "${step.agent}" not found. Available: ${Array.from(allAgents.keys()).join(", ")}`,
					fullOutput: "",
					fullOutputPath: "",
					success: false,
					elapsed: Date.now() - chainStart,
				};
			}

			const result = await runAgent(agentDef, resolvedPrompt, i, ctx);

			if (result.exitCode !== 0) {
				stepStates[i].status = "error";
				updateWidget();
				return {
					output: `Error at step ${i + 1} (${step.agent}): ${result.output}`,
					fullOutput: result.fullOutput || "",
					fullOutputPath: result.fullOutputPath || "",
					success: false,
					elapsed: Date.now() - chainStart,
				};
			}

			stepStates[i].status = "done";
			updateWidget();

			stepOutputs.push(result.output);
			input = result.output;
			lastFullOutput = result.fullOutput || "";
			lastFullOutputPath = result.fullOutputPath || "";
		}

		return { output: input, fullOutput: lastFullOutput, fullOutputPath: lastFullOutputPath, success: true, elapsed: Date.now() - chainStart };
	}

	// ── run_chain Tool ──────────────────────────

	registerToolWithExecutor(pi, {
		name: "run_chain",
		label: "Run Chain",
		description: "Execute the active agent chain pipeline. Each step runs sequentially — output from one step feeds into the next. Agents maintain session context across runs.",
		parameters: Type.Object({
			task: Type.String({ description: "The task/prompt for the chain to process" }),
			chain: Type.Optional(Type.String({ description: "Chain name to activate first, e.g. plan-build" })),
		}),

		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			widgetCtx = ctx;
			const { task, chain: chainName } = params as { task: string; chain?: string };
			if (chainName) {
				const named = matchNamedOption(chains.map((c) => c.name), chainName);
				const found = named ? chains.find((c) => c.name === named) : undefined;
				if (!found) {
					return {
						content: [{ type: "text", text: `Unknown chain: ${chainName}. Available: ${chains.map((c) => c.name).join(", ")}` }],
						details: { error: true },
					};
				}
				activateChain(found);
			}

			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: `Starting chain: ${activeChain?.name}...` }],
					details: { chain: activeChain?.name, task, status: "running" },
				});
			}

			const result = await explicitDispatchHandler("agent-chain", async () => runChain(task, ctx))();

			// result.output is already the composed precision-preserving index.
			const status = result.success ? "done" : "error";
			const summary = `[chain:${activeChain?.name}] ${status} in ${Math.round(result.elapsed / 1000)}s`;

			return {
				content: [{ type: "text", text: `${summary}\n\n${result.output}` }],
				details: {
					chain: activeChain?.name,
					task,
					status,
					elapsed: result.elapsed,
					fullOutput: result.fullOutput ?? "",
					fullOutputPath: result.fullOutputPath ?? "",
				},
			};
		},

		renderCall(args, theme) {
			const task = (args as any).task || "";
			const preview = task.length > 60 ? task.slice(0, 57) + "..." : task;
			const text =
				theme.fg("toolTitle", theme.bold("run_chain ")) +
				theme.fg("accent", activeChain?.name || "?") +
				theme.fg("dim", " — ") +
				theme.fg("muted", preview);
			return new Text(outputLine(theme, "accent", text), 0, 0);
		},

		renderResult(result, options, theme) {
			const details = result.details as any;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (options.isPartial || details.status === "running") {
				const runningBtn = statusButton("running", details.chain || "chain", theme);
				return new Text(outputLine(theme, "accent", runningBtn), 0, 0);
			}

			const status = details.status === "done" ? "done" : "error";
			const bar = status === "done" ? "success" : "error";
			const statusBtn = statusButton(status, details.chain, theme);
			const elapsed = typeof details.elapsed === "number" ? Math.round(details.elapsed / 1000) : 0;
			const header = statusBtn +
				theme.fg("dim", ` ${elapsed}s`);

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

	// ── Commands ─────────────────────────────────

	registerTaskStatusCommand(pi, () => sessionDir);

	pi.registerCommand("chain", {
		description: "Switch active chain: /chain or /chain <name>",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = chains.map((chain) => ({ value: chain.name, label: chain.name, description: chain.description }));
			const filtered = items.filter((item) => item.value.startsWith(prefix.trim()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			widgetCtx = ctx;
			if (chains.length === 0) {
				ctx.ui.notify("No chains defined in .pi/agents/agent-chain.yaml", "warning");
				return;
			}

			const named = matchNamedOption(chains.map((c) => c.name), args || "");
			let chain = named ? chains.find((c) => c.name === named) : undefined;
			if (!chain) {
				const options = chains.map(c => {
					const steps = c.steps.map(s => displayName(s.agent)).join(" → ");
					const desc = c.description ? ` — ${c.description}` : "";
					return `${c.name}${desc} (${steps})`;
				});

				const choice = await ctx.ui.select("Select Chain", options);
				if (choice === undefined) return;
				chain = chains[options.indexOf(choice)];
			}
			if (!chain) return;

			activateChain(chain);
			const flow = chain.steps.map(s => displayName(s.agent)).join(" → ");
			ctx.ui.setStatus("agent-chain", `Chain: ${chain.name} (${chain.steps.length} steps)`);
			ctx.ui.notify(
				`Chain: ${chain.name}\n${chain.description}\n${flow}`,
				"info",
			);
		},
	});

	pi.registerCommand("chain-clear", {
		description: "Clear chain widget from screen",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;
			ctx.ui.setWidget("agent-chain", undefined);

			// Reset step states to pending so the widget can reappear on next run
			for (const s of stepStates) {
				s.status = "pending";
				s.elapsed = 0;
				s.lastWork = "";
			}
			selectedStepIndex = -1;

			ctx.ui.notify("Chain widget cleared.", "info");
		},
	});

	pi.registerCommand("chain-list", {
		description: "List all available chains",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;
			if (chains.length === 0) {
				ctx.ui.notify("No chains defined in .pi/agents/agent-chain.yaml", "warning");
				return;
			}

			const list = chains.map(c => {
				const desc = c.description ? `  ${c.description}` : "";
				const steps = c.steps.map((s, i) =>
					`  ${i + 1}. ${displayName(s.agent)}`
				).join("\n");
				return `${c.name}:${desc ? "\n" + desc : ""}\n${steps}`;
			}).join("\n\n");

			ctx.ui.notify(list, "info");
		},
	});

	pi.registerCommand("audit", {
		description: "Run comprehensive code audit — scans project, finds issues, generates report and hardening plan",
		handler: async (args, ctx) => {
			widgetCtx = ctx;
			const scope = (args || "").trim();
			const scopeHint = scope ? ` (scope: ${scope})` : "";

			ctx.ui.notify(`Starting code audit${scopeHint}...`, "info");

			// Find audit chain
			const auditChain = chains.find(c => c.name === "audit");
			if (!auditChain) {
				ctx.ui.notify("Audit chain not found in .pi/agents/agent-chain.yaml", "error");
				return;
			}

			// Activate the audit chain
			activateChain(auditChain);

			// Build task string with optional scope
			const task = scope
				? `Audit this codebase. Scope: ${scope}`
				: "Audit this codebase";

			// Run the chain
			const result = await explicitDispatchHandler("agent-chain", async () => runChain(task, ctx))();

			// Hide chain widget — audit is done, result goes to file
			widgetCtx.ui.setWidget("agent-chain", undefined);

			if (!result.success) {
				ctx.ui.notify(`Audit failed: ${result.output.slice(0, 200)}`, "error");
				return;
			}

			// Write report file
			const reportPath = join(ctx.cwd, ".pi", "audit-report.md");
			const reportDir = dirname(reportPath);
			if (!existsSync(reportDir)) {
				mkdirSync(reportDir, { recursive: true });
			}
			writeFileSync(reportPath, result.output, "utf-8");

			ctx.ui.notify(`Audit complete! Report saved to ${reportPath}`, "success");
		},
	});

	pi.registerCommand("performance", {
		description: "Optimize this codebase for performance — profile bottlenecks, stress-test, and build an optimization plan",
		handler: async (args, ctx) => {
			widgetCtx = ctx;
			const scope = (args || "").trim();
			const scopeHint = scope ? ` (scope: ${scope})` : "";

			ctx.ui.notify(`Starting performance analysis${scopeHint}...`, "info");

			// Find performance chain
			const perfChain = chains.find(c => c.name === "performance");
			if (!perfChain) {
				ctx.ui.notify("Performance chain not found in .pi/agents/agent-chain.yaml", "error");
				return;
			}

			// Activate the performance chain
			activateChain(perfChain);

			// Build task string with optional scope
			const task = scope
				? `Optimize this codebase for performance. Scope: ${scope}`
				: "Optimize this codebase for performance";

			// Run the chain
			const result = await explicitDispatchHandler("agent-chain", async () => runChain(task, ctx))();

			// Hide chain widget — performance analysis is done, result goes to file
			widgetCtx.ui.setWidget("agent-chain", undefined);

			if (!result.success) {
				ctx.ui.notify(`Performance analysis failed: ${result.output.slice(0, 200)}`, "error");
				return;
			}

			// Write report file
			const reportPath = join(ctx.cwd, ".pi", "performance-report.md");
			const reportDir = dirname(reportPath);
			if (!existsSync(reportDir)) {
				mkdirSync(reportDir, { recursive: true });
			}
			writeFileSync(reportPath, result.output, "utf-8");

			ctx.ui.notify(`Performance analysis complete! Report saved to ${reportPath}`, "success");
		},
	});

	pi.registerCommand("sentry-setup", {
		description: "Verify Sentry CLI setup — check auth, project linking, SDK integration, and DSN configuration",
		handler: async (args, ctx) => {
			widgetCtx = ctx;
			const scope = (args || "").trim();
			const scopeHint = scope ? ` (scope: ${scope})` : "";

			ctx.ui.notify(`Starting Sentry setup check${scopeHint}...`, "info");

			// Find sentry-setup chain
			const sentrySetupChain = chains.find(c => c.name === "sentry-setup");
			if (!sentrySetupChain) {
				ctx.ui.notify("sentry-setup chain not found in .pi/agents/agent-chain.yaml", "error");
				return;
			}

			// Activate the sentry-setup chain
			activateChain(sentrySetupChain);

			// Build task string with optional scope
			const task = scope
				? `Verify Sentry setup for this project. Scope: ${scope}`
				: "Verify Sentry setup for this project";

			// Run the chain
			const result = await explicitDispatchHandler("agent-chain", async () => runChain(task, ctx))();

			// Hide chain widget
			widgetCtx.ui.setWidget("agent-chain", undefined);

			if (!result.success) {
				ctx.ui.notify(`Sentry setup check failed: ${result.output.slice(0, 200)}`, "error");
				return;
			}

			// Write report file
			const reportPath = join(ctx.cwd, ".pi", "sentry-setup-report.md");
			const reportDir = dirname(reportPath);
			if (!existsSync(reportDir)) {
				mkdirSync(reportDir, { recursive: true });
			}
			writeFileSync(reportPath, result.output, "utf-8");

			ctx.ui.notify(`Sentry setup check complete! Report saved to ${reportPath}`, "success");
		},
	});

	pi.registerCommand("sentry-logs", {
		description: "Fetch Sentry issues and crashes, analyze root causes, and create a prioritized fix plan",
		handler: async (args, ctx) => {
			widgetCtx = ctx;
			const scope = (args || "").trim();
			const scopeHint = scope ? ` (scope: ${scope})` : "";

			ctx.ui.notify(`Starting Sentry issue analysis${scopeHint}...`, "info");

			// Find sentry-logs chain
			const sentryLogsChain = chains.find(c => c.name === "sentry-logs");
			if (!sentryLogsChain) {
				ctx.ui.notify("sentry-logs chain not found in .pi/agents/agent-chain.yaml", "error");
				return;
			}

			// Activate the sentry-logs chain
			activateChain(sentryLogsChain);

			// Build task string with optional scope
			const task = scope
				? `Get Sentry issues and crashes for this project and create a fix plan. Scope: ${scope}`
				: "Get Sentry issues and crashes for this project and create a fix plan";

			// Run the chain
			const result = await explicitDispatchHandler("agent-chain", async () => runChain(task, ctx))();

			// Hide chain widget
			widgetCtx.ui.setWidget("agent-chain", undefined);

			if (!result.success) {
				ctx.ui.notify(`Sentry issue analysis failed: ${result.output.slice(0, 200)}`, "error");
				return;
			}

			// Write report file
			const reportPath = join(ctx.cwd, ".pi", "sentry-report.md");
			const reportDir = dirname(reportPath);
			if (!existsSync(reportDir)) {
				mkdirSync(reportDir, { recursive: true });
			}
			writeFileSync(reportPath, result.output, "utf-8");

			ctx.ui.notify(`Sentry issue analysis complete! Report saved to ${reportPath}`, "success");
		},
	});

	pi.registerCommand("code-review", {
		description: "Multi-pass code review — parallel context gathering, split review, remediation, validation, test verification, and final report",
		handler: async (args, ctx) => {
			widgetCtx = ctx;
			const inlineScope = (args || "").trim();

			// Find code-review chain
			const codeReviewChain = chains.find(c => c.name === "code-review");
			if (!codeReviewChain) {
				ctx.ui.notify("code-review chain not found in .pi/agents/agent-chain.yaml", "error");
				return;
			}

			let task: string;

			if (inlineScope) {
				// User passed scope inline: /code-review src/auth/
				task = `Review the code. Scope: ${inlineScope}`;
			} else {
				// Interactive scope picker
				const scopeOptions = [
					"Last commit (git diff HEAD~1)",
					"Unstaged changes (git diff)",
					"Staged changes (git diff --cached)",
					"Last 3 commits (git diff HEAD~3)",
					"Specific file or directory",
					"Full codebase",
				];

				const choice = await ctx.ui.select("What do you want to review?", scopeOptions);
				if (choice === undefined) return;

				switch (choice) {
					case scopeOptions[0]:
						task = "Review the changes in the last commit. Use `git diff HEAD~1` to identify changed files.";
						break;
					case scopeOptions[1]:
						task = "Review the current unstaged changes. Use `git diff` to identify changed files.";
						break;
					case scopeOptions[2]:
						task = "Review the staged changes. Use `git diff --cached` to identify changed files.";
						break;
					case scopeOptions[3]:
						task = "Review the changes in the last 3 commits. Use `git diff HEAD~3` to identify changed files.";
						break;
					case scopeOptions[4]: {
						const path = await ctx.ui.input("Enter file or directory path:", "src/");
						if (!path) return;
						task = `Review the code at: ${path}`;
						break;
					}
					case scopeOptions[5]:
						task = "Review the full codebase. Scan all source files.";
						break;
					default:
						task = "Review the current unstaged changes. Use `git diff` to identify changed files.";
				}
			}

			ctx.ui.notify(`Starting code review...`, "info");

			// Activate the code-review chain
			activateChain(codeReviewChain);

			// Run the chain
			const result = await explicitDispatchHandler("agent-chain", async () => runChain(task, ctx))();

			// Hide chain widget
			widgetCtx.ui.setWidget("agent-chain", undefined);

			if (!result.success) {
				ctx.ui.notify(`Code review failed: ${result.output.slice(0, 200)}`, "error");
				return;
			}

			// Write report file
			const reportPath = join(ctx.cwd, ".pi", "code-review-report.md");
			const reportDir = dirname(reportPath);
			if (!existsSync(reportDir)) {
				mkdirSync(reportDir, { recursive: true });
			}
			writeFileSync(reportPath, result.output, "utf-8");

			ctx.ui.notify(`Code review complete! Report saved to ${reportPath}`, "success");
		},
	});

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
- Warm, professional, collaborative tone — no emojis anywhere` : "";

		return {
			systemPrompt: `You are the coordinator for a sequential pipeline called "${activeChain.name}".${desc}

${ORCHESTRATED_TASK_PROMPT}

${RESEARCH_ROUTING_PROMPT}

You orchestrate via \`run_chain\`. Do not implement, test, or re-verify the chain's work yourself (no bash, python, write, or edit for that work). After run_chain returns, quote the step summaries from ## RESULT.

${GRILL_ME_SECTION}

## Active Chain: ${activeChain.name}
Flow: ${flow}

${steps}

## Agent Details

${agentCatalog}

## When to Use run_chain
- Significant work: new features, refactors, multi-file changes, anything non-trivial
- Tasks that benefit from the full pipeline: planning, building, reviewing
- When you want structured, multi-agent collaboration on a problem

## When not to work directly
- Do not write files or run verification the chain already ran
- Quick questions to the user are fine; use NORMAL for trivial one-file edits
- Any leftover edit or execution still requires an active task

## How run_chain Works
- Pass a clear task description to run_chain
- Each step's output feeds into the next step as $INPUT
- Agents maintain session context — they remember previous work within this session
- You can run the chain multiple times with different tasks if needed
- After the chain completes, report the RESULT summaries — do not re-run them${commanderSection}`,
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
		) {}

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
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			const name = displayName(this.step.agent);
			const statusForButton = this.step.status === "pending" ? "idle" : this.step.status;
			const statusBtn = statusButton(statusForButton, name, theme);
			const timeStr = this.step.status !== "pending" && this.step.elapsed > 0
				? ` ${Math.round(this.step.elapsed / 1000)}s` : "";
			container.addChild(new Text(`${statusBtn}${timeStr}`, 1, 0));
			container.addChild(new Spacer(1));

			// Section header helper
			const sectionHeader = (title: string) => {
				const label = ` ─── ${title} `;
				const remaining = Math.max(0, innerWidth - visibleWidth(label));
				return theme.fg("accent", theme.bold(label + "─".repeat(remaining)));
			};

			// Metadata section
			container.addChild(new Text(sectionHeader("METADATA"), 1, 0));
			const formatRow = (label: string, value: string, valueColor: string = "muted") => {
				const labelStr = theme.fg("accent", theme.bold(padRight(label + ":", 14)));
				const valueStr = theme.fg(valueColor, value);
				return labelStr + " " + valueStr;
			};

			const addWrappedRow = (label: string, value: string, valueColor: string = "muted") => {
				const labelWidth = 14;
				const valueWidth = innerWidth - labelWidth - 1;
				const wrapped = wordWrap(value, valueWidth);
				for (let i = 0; i < wrapped.length; i++) {
					const displayLabel = i === 0 ? label : "";
					container.addChild(new Text(formatRow(displayLabel, wrapped[i], valueColor), 1, 0));
				}
			};

			const statusColorMap: Record<string, string> = { running: "accent", done: "success", error: "error", pending: "dim" };
			const statusColor = statusColorMap[this.step.status] || "muted";
			container.addChild(new Text(formatRow("STATUS", this.step.status.toUpperCase(), statusColor), 1, 0));

			if (this.step.description) {
				addWrappedRow("DESCRIPTION", this.step.description, "muted");
			}

			if (this.agentDef?.tools) {
				addWrappedRow("TOOLS", this.agentDef.tools, "success");
			}

			container.addChild(new Spacer(1));

			// System prompt section
			if (this.agentDef?.systemPrompt) {
				container.addChild(new Text(sectionHeader("SYSTEM PROMPT"), 1, 0));
				container.addChild(new Spacer(1));
				const sysPromptMd = new Markdown(this.agentDef.systemPrompt, 1, 0, mdTheme);
				container.addChild(sysPromptMd);
				container.addChild(new Spacer(1));
			}

			// Last work section
			if (this.step.lastWork) {
				container.addChild(new Text(sectionHeader("LAST WORK"), 1, 0));
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
				invalidate: () => {},
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
			if (mode !== "CHAIN") hideChainWidget(ctx);
			else updateWidget();
		});

		// Reset execution state — widget re-registration deferred to before_agent_start
		stepStates = [];
		activeChain = null;
		setActiveChain(null);
		selectedStepIndex = -1;
		pendingReset = true;

		// Wipe chain session files — reset agent context on /new and launch
		const sessDir = join(_ctx.cwd, ".pi", "agent-sessions");
		if (existsSync(sessDir)) {
			for (const f of readdirSync(sessDir)) {
				if (f.startsWith("chain-") && f.endsWith(".json")) {
					try { unlinkSync(join(sessDir, f)); } catch {}
				}
			}
		}

		// Reload chains + clear agentSessions map (all agents start fresh)
		loadChains(_ctx.cwd);

		if (chains.length === 0) {
			_ctx.ui.notify("No chains found in .pi/agents/agent-chain.yaml", "warning");
			return;
		}

		// Default to first chain — use /chain to switch
		activateChain(chains[0]);

		// ── Expose global hooks for escape-cancel integration ────────────
		(globalThis as any).__piKillChainProc = (): boolean => {
			if (currentChainProc) {
				try { currentChainProc.kill("SIGTERM"); } catch {}
				currentChainProc = null;
				return true;
			}
			return false;
		};
		(globalThis as any).__piHasRunningChain = (): boolean => {
			return currentChainProc !== null;
		};

		// run_chain is registered as a tool — available alongside all default tools

		_ctx.ui.setStatus("agent-chain", `Chain: ${activeChain!.name} (${activeChain!.steps.length} steps)`);
		// Footer: use footer.ts only — do not overwrite

		// Register nav provider for F-key navigation
		const providers = ((globalThis as any).__piNavProviders = (globalThis as any).__piNavProviders || []);
		providers.push({
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
		});
	}));
}
