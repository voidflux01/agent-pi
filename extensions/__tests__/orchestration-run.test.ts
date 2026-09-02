import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createOrchestrationRun, RunBudgetError } from "../lib/orchestration-run.ts";
import { activeRunMarkerPath } from "../lib/orchestration-run.ts";
import { summarizeOrchestrationRun } from "../lib/orchestration-query.ts";
import { listRunEvents } from "../lib/evidence-store.ts";
import { clearOrchestrationBudget, initOrchestrationBudget, recordBudgetUsage } from "../lib/orchestration-budget.ts";

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

	test("persists a parent event trail for headless contexts without a session file", () => {
		const cwd = mkdtempSync(join(tmpdir(), "agent-pi-headless-"));
		const run = createOrchestrationRun({ context: { cwd }, actor: "headless-parent" });
		run.record("dispatch.started", { launchId: "headless" });
		run.finish("succeeded");
		expect(run.eventDir).toBe(join(cwd, ".pi", "agent-sessions", "compositions", run.runId));
		expect(listRunEvents(run.eventDir!).map((event) => event.type)).toEqual(["run.started", "dispatch.started", "run.succeeded"]);
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

	test("marks a non-terminal run stale when its active process is gone", () => {
		const eventDir = join(mkdtempSync(join(tmpdir(), "agent-pi-run-")), "run");
		const run = createOrchestrationRun({ eventDir, actor: "test" });
		writeFileSync(activeRunMarkerPath(eventDir), JSON.stringify({ pid: 2147483647, startedAt: Date.now(), runId: run.runId }));
		expect(summarizeOrchestrationRun(eventDir)).toMatchObject({ status: "stale", recovery: "stale", lastEventType: "run.started" });
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

	test("records changed workspace files for an auditable parent run", () => {
		const cwd = mkdtempSync(join(tmpdir(), "agent-pi-workspace-"));
		execFileSync("git", ["init", "-q"], { cwd });
		writeFileSync(join(cwd, "tracked.txt"), "before\n");
		execFileSync("git", ["add", "tracked.txt"], { cwd });
		const eventDir = join(cwd, ".pi", "events");
		const run = createOrchestrationRun({ eventDir, actor: "test", workspaceCwd: cwd });
		writeFileSync(join(cwd, "tracked.txt"), "after\n");
		run.finish("succeeded");
		const workspaceEvent = run.events.find((event) => event.type === "workspace.changed");
		expect(workspaceEvent?.payload).toMatchObject({ changedFiles: ["tracked.txt"] });
	});
});
