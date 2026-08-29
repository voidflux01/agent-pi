// ABOUTME: Tests for implementation-worker tool-call caps.
import { describe, expect, it } from "vitest";
import {
	IMPLEMENTATION_WORKER_MAX_TOOLS,
	IMPLEMENTATION_WORKER_TIMEOUT_MS,
	DEFAULT_WORKER_TIMEOUT_MS,
	applyWorkerLaunchPolicy,
	isImplementationWorker,
	workerHitToolCap,
	workerTimeoutMs,
} from "../lib/worker-budget.ts";

describe("worker budget", () => {
	it("recognizes builder roles", () => {
		expect(isImplementationWorker("builder")).toBe(true);
		expect(isImplementationWorker("builder-kimi-k2-5")).toBe(true);
		expect(isImplementationWorker("planner")).toBe(false);
		expect(isImplementationWorker("reviewer")).toBe(false);
	});

	it("trips only after the cap for builders", () => {
		expect(workerHitToolCap("builder", IMPLEMENTATION_WORKER_MAX_TOOLS - 1)).toBe(false);
		expect(workerHitToolCap("builder", IMPLEMENTATION_WORKER_MAX_TOOLS)).toBe(true);
		expect(workerHitToolCap("planner", 500)).toBe(false);
	});

	it("gives builders a shorter wall clock than planners", () => {
		expect(workerTimeoutMs("builder")).toBe(IMPLEMENTATION_WORKER_TIMEOUT_MS);
		expect(workerTimeoutMs("planner")).toBe(DEFAULT_WORKER_TIMEOUT_MS);
		expect(IMPLEMENTATION_WORKER_TIMEOUT_MS).toBeLessThan(DEFAULT_WORKER_TIMEOUT_MS);
	});

	it("pins builder thinking to low without duplicating the flag", () => {
		const first = applyWorkerLaunchPolicy(["pi", "--mode", "json", "task"], "builder");
		expect(first.command.slice(0, 4)).toEqual(["pi", "--thinking", "low", "--mode"]);
		expect(first.timeoutMs).toBe(IMPLEMENTATION_WORKER_TIMEOUT_MS);
		const again = applyWorkerLaunchPolicy(first.command, "builder");
		expect(again.command.filter((t) => t === "--thinking")).toHaveLength(1);
		const planner = applyWorkerLaunchPolicy(["pi", "--mode", "json", "task"], "planner");
		expect(planner.command).toEqual(["pi", "--mode", "json", "task"]);
	});
});
