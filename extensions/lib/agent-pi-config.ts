// ABOUTME: Global agent-pi runtime configuration with bundled defaults.
// ABOUTME: Project-local configuration is intentionally not supported.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type WorkerThinking = "low" | "medium" | "high";

export interface AgentPiConfig {
	models: { default?: string; toolkit?: string; byAgent: Record<string, string> };
	workers: {
		thinking: { default: WorkerThinking; byAgent: Record<string, WorkerThinking> };
		timeoutsMs: { default: number; planner: number; reviewer: number; verifier: number };
	};
	orchestration?: { maxSteps?: number; pipelineMaxParallel?: number };
	ui: { herdrSuccessLingerMs: number | null; herdrErrorLingerMs: number | null; widgetAutoRemoveMs: number; cleanupStaleAfterMs: number };
	interaction: { askParentTimeoutMs: number };
}

const EXT_PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GLOBAL_CONFIG_PATH = join(homedir(), ".pi", "agent", "agent-pi.json");

const DEFAULT_CONFIG: AgentPiConfig = {
	models: { byAgent: {} },
	workers: {
		thinking: { default: "medium", byAgent: {} },
		timeoutsMs: { default: 15 * 60_000, planner: 120_000, reviewer: 120_000, verifier: 10 * 60_000 },
	},
	orchestration: { maxSteps: 16, pipelineMaxParallel: 4 },
	ui: { herdrSuccessLingerMs: 30_000, herdrErrorLingerMs: null, widgetAutoRemoveMs: 30_000, cleanupStaleAfterMs: 600_000 },
	interaction: { askParentTimeoutMs: 600_000 },
};

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function optionalDuration(value: unknown, fallback: number | null): number | null {
	if (value === null) return null;
	return finiteNumber(value, fallback ?? 0, 0, 24 * 60 * 60_000);
}

function validThinking(value: unknown): value is WorkerThinking {
	return value === "low" || value === "medium" || value === "high";
}

function normalize(raw: unknown): AgentPiConfig {
	const input = raw && typeof raw === "object" ? raw as any : {};
	const models = input.models && typeof input.models === "object" ? input.models : {};
	const workers = input.workers && typeof input.workers === "object" ? input.workers : {};
	const thinking = workers.thinking && typeof workers.thinking === "object" ? workers.thinking : {};
	const timeouts = workers.timeoutsMs && typeof workers.timeoutsMs === "object" ? workers.timeoutsMs : {};
	const byAgent: Record<string, WorkerThinking> = {};
	if (thinking.byAgent && typeof thinking.byAgent === "object") {
		for (const [name, level] of Object.entries(thinking.byAgent)) if (validThinking(level)) byAgent[name.toLowerCase()] = level;
	}
	const modelByAgent: Record<string, string> = {};
	if (models.byAgent && typeof models.byAgent === "object") {
		for (const [name, model] of Object.entries(models.byAgent)) if (typeof model === "string" && model.trim()) modelByAgent[name.toLowerCase()] = model.trim();
	}
	const orchestration = input.orchestration && typeof input.orchestration === "object" ? input.orchestration : {};
	const ui = input.ui && typeof input.ui === "object" ? input.ui : {};
	const interaction = input.interaction && typeof input.interaction === "object" ? input.interaction : {};
	return {
		models: {
			byAgent: modelByAgent,
			...(typeof models.default === "string" && models.default.trim() ? { default: models.default.trim() } : {}),
			...(typeof models.toolkit === "string" && models.toolkit.trim() ? { toolkit: models.toolkit.trim() } : {}),
		},
		workers: {
			thinking: { default: validThinking(thinking.default) ? thinking.default : DEFAULT_CONFIG.workers.thinking.default, byAgent },
			timeoutsMs: {
				default: finiteNumber(timeouts.default, DEFAULT_CONFIG.workers.timeoutsMs.default, 1_000, 60 * 60_000),
				planner: finiteNumber(timeouts.planner, DEFAULT_CONFIG.workers.timeoutsMs.planner, 1_000, 60 * 60_000),
				reviewer: finiteNumber(timeouts.reviewer, DEFAULT_CONFIG.workers.timeoutsMs.reviewer, 1_000, 60 * 60_000),
				verifier: finiteNumber(timeouts.verifier, DEFAULT_CONFIG.workers.timeoutsMs.verifier, 1_000, 60 * 60_000),
			},
		},
		orchestration: {
			maxSteps: Math.round(finiteNumber(orchestration.maxSteps, DEFAULT_CONFIG.orchestration!.maxSteps!, 1, 64)),
			pipelineMaxParallel: Math.round(finiteNumber(orchestration.pipelineMaxParallel, DEFAULT_CONFIG.orchestration!.pipelineMaxParallel!, 1, 64)),
		},
		ui: {
			herdrSuccessLingerMs: optionalDuration(ui.herdrSuccessLingerMs, DEFAULT_CONFIG.ui.herdrSuccessLingerMs),
			herdrErrorLingerMs: optionalDuration(ui.herdrErrorLingerMs, DEFAULT_CONFIG.ui.herdrErrorLingerMs),
			widgetAutoRemoveMs: finiteNumber(ui.widgetAutoRemoveMs, DEFAULT_CONFIG.ui.widgetAutoRemoveMs, 0, 24 * 60 * 60_000),
			cleanupStaleAfterMs: finiteNumber(ui.cleanupStaleAfterMs, DEFAULT_CONFIG.ui.cleanupStaleAfterMs, 0, 24 * 60 * 60_000),
		},
		interaction: { askParentTimeoutMs: finiteNumber(interaction.askParentTimeoutMs, DEFAULT_CONFIG.interaction.askParentTimeoutMs, 1_000, 30 * 60_000) },
	};
}

function readConfig(path: string): unknown | undefined {
	try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined; } catch { return undefined; }
}

export function loadAgentPiConfig(): AgentPiConfig {
	return normalize(readConfig(GLOBAL_CONFIG_PATH) ?? readConfig(join(EXT_PROJECT_DIR, "agents", "agent-pi.json")) ?? DEFAULT_CONFIG);
}

export const AGENT_PI_CONFIG = loadAgentPiConfig();
export const AGENT_PI_GLOBAL_CONFIG_PATH = GLOBAL_CONFIG_PATH;

export function configuredModelForAgent(agentName: string): string | undefined {
		const name = agentName.trim().toLowerCase();
		return AGENT_PI_CONFIG.models.byAgent[name] || (name.endsWith("-agent") ? AGENT_PI_CONFIG.models.byAgent[name.slice(0, -6)] : undefined) || (name === "toolkit" ? AGENT_PI_CONFIG.models.toolkit : undefined);
}
