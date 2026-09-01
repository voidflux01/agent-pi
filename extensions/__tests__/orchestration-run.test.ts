import { afterEach, describe, expect, test } from "bun:test";
import { createOrchestrationRun, RunBudgetError } from "../lib/orchestration-run.ts";

describe("orchestration run context", () => {
	test("assigns an id and records a bounded event trail", () => {
		const run = createOrchestrationRun({ budget: { maxSteps: 2 }, actor: "test" });
		run.consumeStep();
		run.record("step.completed", { index: 0 });
		run.finish("succeeded");
		expect(run.runId).toMatch(/^[0-9a-f-]{36}$/);
		expect(run.stepsUsed).toBe(1);
		expect(run.events.map((event) => event.type)).toEqual(["run.started", "step.completed", "run.succeeded"]);
	});

	test("blocks work beyond the run step budget", () => {
		const run = createOrchestrationRun({ budget: { maxSteps: 1 } });
		run.consumeStep();
		expect(() => run.consumeStep()).toThrow(RunBudgetError);
		expect(run.stepsUsed).toBe(1);
	});
});
