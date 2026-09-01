import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOrchestrationRun, RunBudgetError } from "../lib/orchestration-run.ts";
import { activeRunMarkerPath } from "../lib/orchestration-run.ts";
import { summarizeOrchestrationRun } from "../lib/orchestration-query.ts";

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

	test("marks a non-terminal run stale when its active process is gone", () => {
		const eventDir = join(mkdtempSync(join(tmpdir(), "agent-pi-run-")), "run");
		const run = createOrchestrationRun({ eventDir, actor: "test" });
		writeFileSync(activeRunMarkerPath(eventDir), JSON.stringify({ pid: 2147483647, startedAt: Date.now(), runId: run.runId }));
		expect(summarizeOrchestrationRun(eventDir)?.status).toBe("stale");
		run.finish("cancelled");
	});

	test("finishes exactly once and removes the active lease", () => {
		const eventDir = join(mkdtempSync(join(tmpdir(), "agent-pi-run-")), "run");
		const run = createOrchestrationRun({ eventDir, actor: "test" });
		run.finish("succeeded");
		run.finish("failed");
		expect(run.events.map((event) => event.type)).toEqual(["run.started", "run.succeeded"]);
		expect(existsSync(activeRunMarkerPath(eventDir))).toBe(false);
	});
});
