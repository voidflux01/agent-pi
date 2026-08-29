// ABOUTME: Tests for per-role thinking, timeout, and tool-call policy.
import { describe, expect, it } from "vitest";
import {
	IMPLEMENTATION_WORKER_MAX_TOOLS,
	IMPLEMENTATION_WORKER_TIMEOUT_MS,
	DEFAULT_WORKER_TIMEOUT_MS,
	TOOLKIT_WORKER_TIMEOUT_MS,
	applyWorkerLaunchPolicy,
	isExecutionWorker,
	isImplementationWorker,
	workerHitToolCap,
	workerThinkingLevel,
	workerTimeoutMs,
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
		expect(workerThinkingLevel("planner")).toBe("high");
		expect(workerThinkingLevel("reviewer")).toBe("high");
		expect(workerThinkingLevel("warden")).toBe("high");
		expect(workerThinkingLevel("codex-agent")).toBeUndefined();
		expect(workerThinkingLevel("omp-agent")).toBeUndefined();
		expect(workerThinkingLevel("unknown-role")).toBe("medium");
	});

	it("caps execution workers, not reviewers", () => {
		expect(isImplementationWorker("builder")).toBe(true);
		expect(isExecutionWorker("paladin")).toBe(true);
		expect(isExecutionWorker("tester")).toBe(true);
		expect(isExecutionWorker("planner")).toBe(false);
		expect(workerHitToolCap("paladin", IMPLEMENTATION_WORKER_MAX_TOOLS)).toBe(true);
		expect(workerHitToolCap("planner", 500)).toBe(false);
	});

	it("uses a short clock for low-thinking roles and longer for review/toolkit", () => {
		expect(workerTimeoutMs("builder")).toBe(IMPLEMENTATION_WORKER_TIMEOUT_MS);
		expect(workerTimeoutMs("scout")).toBe(IMPLEMENTATION_WORKER_TIMEOUT_MS);
		expect(workerTimeoutMs("planner")).toBe(DEFAULT_WORKER_TIMEOUT_MS);
		expect(workerTimeoutMs("codex-agent")).toBe(TOOLKIT_WORKER_TIMEOUT_MS);
	});

	it("pins thinking on pi argv without duplicating the flag", () => {
		const first = applyWorkerLaunchPolicy(["pi", "--mode", "json", "task"], "builder");
		expect(first.command.slice(0, 4)).toEqual(["pi", "--thinking", "low", "--mode"]);
		const again = applyWorkerLaunchPolicy(first.command, "builder");
		expect(again.command.filter((t) => t === "--thinking")).toHaveLength(1);
		const planner = applyWorkerLaunchPolicy(["pi", "--mode", "json", "task"], "planner");
		expect(planner.command.slice(0, 4)).toEqual(["pi", "--thinking", "high", "--mode"]);
		const toolkit = applyWorkerLaunchPolicy(["pi", "--mode", "json", "task"], "omp-agent");
		expect(toolkit.command).toEqual(["pi", "--mode", "json", "task"]);
		expect(toolkit.timeoutMs).toBe(TOOLKIT_WORKER_TIMEOUT_MS);
	});
});
