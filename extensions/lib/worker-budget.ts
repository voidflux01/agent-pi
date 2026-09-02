// ABOUTME: Per-role thinking and tool-call policy for spawned workers.

import { isToolkitCliAgent } from "./toolkit-cli.ts";

export const IMPLEMENTATION_WORKER_MAX_TOOLS = 48;
export const REVIEW_WORKER_MAX_TOOLS = 20;
export const PLANNER_MAX_TOOLS = 32;
export const DEFAULT_PLANNER_TIMEOUT_MS = 120_000;
export const DEFAULT_REVIEW_TIMEOUT_MS = 120_000;
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
	planner: "medium",
	reviewer: "medium",
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

export function isReviewWorker(name: string): boolean {
	const n = normalize(name);
	return n === "reviewer" || n.endsWith("-reviewer");
}

export function workerThinkingLevel(name: string): WorkerThinking | undefined {
	const n = normalize(name);
	if (isToolkitWorker(n)) return undefined;
	if (THINKING_BY_NAME[n]) return THINKING_BY_NAME[n];
	if (isImplementationWorker(n)) return "low";
	return "medium";
}

export function implementationWorkerPrompt(): string {
	return `\n\n## Stop condition
Once the requested files exist and verification has run (tests pass, or there are no tests), emit ## RESULT immediately.
Do not keep reformatting, shrinking line counts, re-reading, or re-running the same tests.
Cosmetic constraints are secondary to a green verification.
Hard stop after ${IMPLEMENTATION_WORKER_MAX_TOOLS} tool calls.`;
}

export function reviewWorkerPrompt(): string {
	return `\n\n## Review stop condition\nPerform one focused review pass over the supplied handoff. First follow the task's explicit acceptance check; do not invent broader checks. If the workspace is not a Git repository, do not run git diff or treat Git metadata as a prerequisite. Run only the checks needed to support a concrete APPROVED or NEEDS CHANGES decision. Do not repeatedly re-read files, rerun identical checks, polish prose, or investigate unrelated issues. Emit the required ## RESULT block immediately after that decision. Hard stop after ${REVIEW_WORKER_MAX_TOOLS} tool calls.`;
}

export function workerHitToolCap(name: string, toolCount: number): boolean {
	if (isReviewWorker(name)) return toolCount >= REVIEW_WORKER_MAX_TOOLS;
	if (normalize(name) === "planner") return toolCount >= PLANNER_MAX_TOOLS;
	return isExecutionWorker(name) && toolCount >= IMPLEMENTATION_WORKER_MAX_TOOLS;
}

export function workerTimeoutMs(name: string): number | undefined {
	if (normalize(name) === "planner") return DEFAULT_PLANNER_TIMEOUT_MS;
	return isReviewWorker(name) ? DEFAULT_REVIEW_TIMEOUT_MS : undefined;
}

/** Insert --thinking when this role has a pinned level. No wall-clock kill. */
export function applyWorkerLaunchPolicy(command: string[], agentName: string): { command: string[] } {
	const thinking = workerThinkingLevel(agentName);
	if (!thinking || command.includes("--thinking")) return { command };
	const out = [...command];
	const start = out[0] === "pi" || /(?:^|\/)pi$/.test(out[0] || "") ? 1 : 0;
	out.splice(start, 0, "--thinking", thinking);
	return { command: out };
}
