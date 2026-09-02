// ABOUTME: Tests for per-role thinking and tool-call policy.
import { describe, expect, it } from "vitest";
import {
	IMPLEMENTATION_WORKER_MAX_TOOLS,
	applyWorkerLaunchPolicy,
	isExecutionWorker,
	isImplementationWorker,
	workerHitToolCap,
	isReviewWorker,
	REVIEW_WORKER_MAX_TOOLS,
	PLANNER_MAX_TOOLS,
	DEFAULT_PLANNER_TIMEOUT_MS,
	DEFAULT_REVIEW_TIMEOUT_MS,
	workerTimeoutMs,
	workerThinkingLevel,
} from "../lib/worker-budget.ts";

describe("worker budget", () => {
	it("maps thinking levels from the role table", () => {
		expect(workerThinkingLevel("builder")).toBe("low");
		expect(workerThinkingLevel("builder-kimi-k2-5")).toBe("low");
		expect(workerThinkingLevel("paladin")).toBe("low");
		expect(workerThinkingLevel("herald")).toBe("low");
		expect(workerThinkingLevel("tester")).toBe("low");
		expect(workerThinkingLevel("scout")).toBe("low");
		expect(workerThinkingLevel("ranger")).toBe("low");
		expect(workerThinkingLevel("documenter")).toBe("medium");
		expect(workerThinkingLevel("ext-expert")).toBe("medium");
		expect(workerThinkingLevel("planner")).toBe("medium");
		expect(workerThinkingLevel("reviewer")).toBe("medium");
		expect(workerThinkingLevel("warden")).toBe("high");
		expect(workerThinkingLevel("codex-agent")).toBeUndefined();
		expect(workerThinkingLevel("omp-agent")).toBeUndefined();
		expect(workerThinkingLevel("unknown-role")).toBe("medium");
	});

	it("caps execution and review workers independently", () => {
		expect(isImplementationWorker("builder")).toBe(true);
		expect(isExecutionWorker("paladin")).toBe(true);
		expect(isExecutionWorker("tester")).toBe(true);
		expect(isExecutionWorker("planner")).toBe(false);
		expect(workerHitToolCap("paladin", IMPLEMENTATION_WORKER_MAX_TOOLS)).toBe(true);
		expect(workerHitToolCap("planner", PLANNER_MAX_TOOLS - 1)).toBe(false);
		expect(isReviewWorker("reviewer")).toBe(true);
		expect(workerHitToolCap("reviewer", REVIEW_WORKER_MAX_TOOLS)).toBe(true);
		expect(workerHitToolCap("planner", PLANNER_MAX_TOOLS)).toBe(true);
		expect(workerTimeoutMs("planner")).toBe(DEFAULT_PLANNER_TIMEOUT_MS);
		expect(workerTimeoutMs("reviewer")).toBe(DEFAULT_REVIEW_TIMEOUT_MS);
		expect(workerTimeoutMs("builder")).toBeUndefined();
	});

	it("pins thinking on pi argv without duplicating the flag", () => {
		const first = applyWorkerLaunchPolicy(["pi", "--mode", "json", "task"], "builder");
		expect(first.command.slice(0, 4)).toEqual(["pi", "--thinking", "low", "--mode"]);
		const again = applyWorkerLaunchPolicy(first.command, "builder");
		expect(again.command.filter((t) => t === "--thinking")).toHaveLength(1);
		const planner = applyWorkerLaunchPolicy(["pi", "--mode", "json", "task"], "planner");
		expect(planner.command.slice(0, 4)).toEqual(["pi", "--thinking", "medium", "--mode"]);
		const toolkit = applyWorkerLaunchPolicy(["pi", "--mode", "json", "task"], "omp-agent");
		expect(toolkit.command).toEqual(["pi", "--mode", "json", "task"]);
	});
});
