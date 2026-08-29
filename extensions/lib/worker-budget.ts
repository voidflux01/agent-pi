// ABOUTME: Stop implementation workers from burning unbounded thinking/time
// ABOUTME: after the work is already done. Caps are a backstop, not the cause.

export const IMPLEMENTATION_WORKER_MAX_TOOLS = 48;
/** Live TEAM builder spent ~3 min getting tests green, then ~5 min shaving lines. */
export const IMPLEMENTATION_WORKER_TIMEOUT_MS = 4 * 60 * 1000;
export const DEFAULT_WORKER_TIMEOUT_MS = 8 * 60 * 1000;
export const IMPLEMENTATION_WORKER_THINKING = "low";

export function isImplementationWorker(name: string): boolean {
	const n = String(name || "").trim().toLowerCase();
	return n === "builder" || n.startsWith("builder-") || n.includes("-builder");
}

export function workerTimeoutMs(name: string): number {
	return isImplementationWorker(name) ? IMPLEMENTATION_WORKER_TIMEOUT_MS : DEFAULT_WORKER_TIMEOUT_MS;
}

export function workerThinkingLevel(name: string): string | undefined {
	return isImplementationWorker(name) ? IMPLEMENTATION_WORKER_THINKING : undefined;
}

export function implementationWorkerPrompt(): string {
	return `\n\n## Stop condition
Once the requested files exist and verification has run (tests pass, or there are no tests), emit ## RESULT immediately.
Do not keep reformatting, shrinking line counts, re-reading, or re-running the same tests.
Cosmetic constraints are secondary to a green verification.
Hard stop after ${IMPLEMENTATION_WORKER_MAX_TOOLS} tool calls.`;
}

export function workerHitToolCap(name: string, toolCount: number): boolean {
	return isImplementationWorker(name) && toolCount >= IMPLEMENTATION_WORKER_MAX_TOOLS;
}

/** Insert --thinking and return the wall-clock cap for this worker. */
export function applyWorkerLaunchPolicy(command: string[], agentName: string): { command: string[]; timeoutMs: number } {
	const timeoutMs = workerTimeoutMs(agentName);
	const thinking = workerThinkingLevel(agentName);
	if (!thinking || command.includes("--thinking")) return { command, timeoutMs };
	const out = [...command];
	const start = out[0] === "pi" || /(?:^|\/)pi$/.test(out[0] || "") ? 1 : 0;
	out.splice(start, 0, "--thinking", thinking);
	return { command: out, timeoutMs };
}
