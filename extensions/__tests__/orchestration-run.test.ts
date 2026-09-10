import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOrchestrationRun, RunBudgetError } from "../lib/orchestration-run.ts";
import { clearOrchestrationBudget, initOrchestrationBudget, recordBudgetUsage } from "../lib/orchestration-budget.ts";

describe("orchestration run context", () => {
	test("assigns an id and records an in-memory event trail", () => {
		const run = createOrchestrationRun({ budget: { maxSteps: 2 }, actor: "test" });
		run.consumeStep();
		run.record("step.completed", { index: 0 });
		run.finish("succeeded");
		expect(run.runId).toMatch(/^[0-9a-f-]{36}$/);
		expect(run.stepsUsed).toBe(1);
		expect(run.events.map((event) => event.type)).toEqual(["run.started", "step.completed", "run.succeeded"]);
	});

	test("writes nothing to disk (no event dir, no ledger artifacts)", () => {
		const run = createOrchestrationRun({ context: { cwd: tmpdir() }, actor: "headless-parent" });
		run.record("dispatch.started", { launchId: "headless" });
		run.finish("succeeded");
		expect("eventDir" in run).toBe(false);
		expect(run.events.map((event) => event.type)).toEqual(["run.started", "dispatch.started", "run.succeeded"]);
	});

	test("blocks work beyond the run step budget", () => {
		const run = createOrchestrationRun({ budget: { maxSteps: 1 } });
		run.consumeStep();
		expect(() => run.consumeStep()).toThrow(RunBudgetError);
		expect(run.stepsUsed).toBe(1);
	});

	test("records measured usage and emits an explicit budget breach", () => {
		const run = createOrchestrationRun({ budget: { maxSteps: 2, maxTokens: 100, maxCostUsd: 1 }, actor: "test" });
		expect(run.recordUsage({ totalTokens: 40, costUsd: 0.25 })).toBe(true);
		expect(run.recordUsage({ totalTokens: 70, costUsd: 0.8 })).toBe(false);
		expect(() => run.consumeStep()).toThrow(RunBudgetError);
		run.finish("succeeded");
		expect(run.budgetExceeded).toBe(true);
		expect(run.signal.aborted).toBe(true);
		expect(run.usage).toEqual({ totalTokens: 110, costUsd: 1.05 });
		expect(run.events.map((event) => event.type)).toEqual(["run.started", "usage.updated", "usage.updated", "budget.exceeded", "run.cancel.requested", "run.failed"]);
		expect(run.events.at(-1)?.payload).toMatchObject({ usage: { totalTokens: 110, costUsd: 1.05 } });
	});

	test("combines external cancellation with the run-owned boundary", () => {
		const controller = new AbortController();
		const run = createOrchestrationRun({ signal: controller.signal, actor: "test" });
		expect(run.signal.aborted).toBe(false);
		controller.abort("user_cancelled");
		expect(run.signal.aborted).toBe(true);
		run.finish("cancelled");
	});

	test("cancels on actual shared spend exhaustion without treating reservations as spend", () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-pi-shared-budget-"));
		try {
			initOrchestrationBudget(dir, 100, 1);
			recordBudgetUsage("worker-a", { totalTokens: 100, costUsd: 0.5 });
			const run = createOrchestrationRun({ actor: "batch-parent" });
			run.recordUsage({ totalTokens: 1, costUsd: 0.01 });
			expect(run.signal.aborted).toBe(true);
			expect(run.events.find((event) => event.type === "budget.exceeded")?.payload).toMatchObject({ scope: "shared" });
			run.finish("cancelled");
		} finally {
			clearOrchestrationBudget();
		}
	});

	test("turns a successful finish into failed when one long step crosses the duration ceiling", async () => {
		const run = createOrchestrationRun({ budget: { maxSteps: 1, maxDurationMs: 1_000 }, actor: "test" });
		run.consumeStep();
		await Bun.sleep(1_025);
		run.finish("succeeded");
		expect(run.events.at(-1)?.type).toBe("run.failed");
		expect(run.events.some((event) => event.type === "budget.exceeded")).toBe(true);
	});

	test("finishes exactly once", () => {
		const run = createOrchestrationRun({ actor: "test" });
		run.finish("succeeded");
		run.finish("failed");
		expect(run.events.map((event) => event.type)).toEqual(["run.started", "run.succeeded"]);
	});
});
