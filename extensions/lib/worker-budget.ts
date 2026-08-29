// ABOUTME: Per-role thinking, wall-clock, and tool-call policy for spawned workers.

import { isToolkitCliAgent } from "./toolkit-cli.ts";

export const IMPLEMENTATION_WORKER_MAX_TOOLS = 48;
export const IMPLEMENTATION_WORKER_TIMEOUT_MS = 4 * 60 * 1000;
export const DEFAULT_WORKER_TIMEOUT_MS = 8 * 60 * 1000;
export const TOOLKIT_WORKER_TIMEOUT_MS = 10 * 60 * 1000;
export const IMPLEMENTATION_WORKER_THINKING = "low";

export type WorkerThinking = "low" | "medium" | "high";

const THINKING_BY_NAME: Record<string, WorkerThinking> = {
	builder: "low",
	paladin: "low",
	herald: "low",
	tester: "low",
	scout: "low",
	ranger: "low",
	"network-scout": "low",
	"port-scan-analyst": "low",
	documenter: "medium",
	"security-news-analyst": "medium",
	"pi-orchestrator": "medium",
	"agent-expert": "medium",
	"ext-expert": "medium",
	"cli-expert": "medium",
	"config-expert": "medium",
	"keybinding-expert": "medium",
	"prompt-expert": "medium",
	"skill-expert": "medium",
	"theme-expert": "medium",
	"tui-expert": "medium",
	planner: "high",
	reviewer: "high",
	warden: "high",
	knight: "high",
	"red-team": "high",
};

const TOOLKIT_EXTRA = new Set(["copilot-agent"]);

function normalize(name: string): string {
	return String(name || "").trim().toLowerCase();
}

export function isToolkitWorker(name: string): boolean {
	const n = normalize(name);
	return isToolkitCliAgent(n) || TOOLKIT_EXTRA.has(n);
}

export function isImplementationWorker(name: string): boolean {
	const n = normalize(name);
	return n === "builder" || n.startsWith("builder-") || n.includes("-builder");
}

/** Write/test workers that must stop after verification, not keep polishing. */
export function isExecutionWorker(name: string): boolean {
	const n = normalize(name);
	return isImplementationWorker(n) || n === "paladin" || n === "herald" || n === "tester";
}

export function workerThinkingLevel(name: string): WorkerThinking | undefined {
	const n = normalize(name);
	if (isToolkitWorker(n)) return undefined;
	if (THINKING_BY_NAME[n]) return THINKING_BY_NAME[n];
	if (isImplementationWorker(n)) return "low";
	return "medium";
}

export function workerTimeoutMs(name: string): number {
	if (isToolkitWorker(name)) return TOOLKIT_WORKER_TIMEOUT_MS;
	return workerThinkingLevel(name) === "low" ? IMPLEMENTATION_WORKER_TIMEOUT_MS : DEFAULT_WORKER_TIMEOUT_MS;
}

export function implementationWorkerPrompt(): string {
	return `\n\n## Stop condition
Once the requested files exist and verification has run (tests pass, or there are no tests), emit ## RESULT immediately.
Do not keep reformatting, shrinking line counts, re-reading, or re-running the same tests.
Cosmetic constraints are secondary to a green verification.
Hard stop after ${IMPLEMENTATION_WORKER_MAX_TOOLS} tool calls.`;
}

export function workerHitToolCap(name: string, toolCount: number): boolean {
	return isExecutionWorker(name) && toolCount >= IMPLEMENTATION_WORKER_MAX_TOOLS;
}

/** Insert --thinking when this role has a pinned level, and return its wall-clock cap. */
export function applyWorkerLaunchPolicy(command: string[], agentName: string): { command: string[]; timeoutMs: number } {
	const timeoutMs = workerTimeoutMs(agentName);
	const thinking = workerThinkingLevel(agentName);
	if (!thinking || command.includes("--thinking")) return { command, timeoutMs };
	const out = [...command];
	const start = out[0] === "pi" || /(?:^|\/)pi$/.test(out[0] || "") ? 1 : 0;
	out.splice(start, 0, "--thinking", thinking);
	return { command: out, timeoutMs };
}
