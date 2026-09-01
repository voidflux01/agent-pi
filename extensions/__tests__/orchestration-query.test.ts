import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrationRun } from "../lib/orchestration-run.ts";
import { buildOrchestrationTopology, listOrchestrationRuns, readOrchestrationEvents, summarizeOrchestrationRun } from "../lib/orchestration-query.ts";

describe("orchestration query", () => {
	test("summarizes persisted run events", () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-pi-query-"));
		const run = createOrchestrationRun({ eventDir: join(dir, "run-1"), actor: "test", mode: "PLAN", parentRunId: "parent-1" });
		run.record("dispatch.started", { launchId: "one" });
		run.record("workspace.changed", { changedFiles: ["src/a.ts"] });
		run.record("verification.completed", { status: "PASS", passed: 2, failed: 0 });
		run.finish("succeeded", { exitCode: 0 });
		const summary = summarizeOrchestrationRun(run.eventDir!);
		expect(summary).toMatchObject({ runId: run.runId, parentRunId: "parent-1", actor: "test", mode: "PLAN", status: "succeeded", eventCount: 5, verificationStatus: "PASS", verificationPassed: 2, verificationFailed: 0, changedFiles: ["src/a.ts"] });
		expect(summary).toMatchObject({ recovery: "terminal", lastEventType: "run.succeeded" });
		expect(readOrchestrationEvents(run.eventDir!, 2).map(event => event.type)).toEqual(["verification.completed", "run.succeeded"]);
	});

	test("ignores missing roots and respects run id filtering", () => {
		const cwd = mkdtempSync(join(tmpdir(), "agent-pi-query-"));
		mkdirSync(join(cwd, ".pi", "agent-sessions", "compositions", "not-a-run"), { recursive: true });
		expect(listOrchestrationRuns(cwd)).toEqual([]);
		expect(listOrchestrationRuns(cwd, { runId: "../escape" })).toEqual([]);
	});

	test("builds bounded parent edges and reports orphan/cycle anomalies", () => {
		const base = (runId: string, parentRunId?: string) => ({ runId, ...(parentRunId ? { parentRunId } : {}), actor: "test", status: "succeeded" as const, eventCount: 1, eventDir: `/tmp/${runId}` });
		const topology = buildOrchestrationTopology([
			base("root"), base("child", "root"), base("orphan", "missing"), base("cycle-a", "cycle-b"), base("cycle-b", "cycle-a"),
		]);
		expect(topology.rootRunIds).toEqual(["root", "orphan"]);
		expect(topology.childrenByParent.root).toEqual(["child"]);
		expect(topology.orphanRunIds).toEqual(["orphan"]);
		expect(topology.cycleRunIds).toEqual(["cycle-a", "cycle-b"]);
	});

	test("projects safe recovery actions for stale chain, pipeline, and subagent runs", () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-pi-recovery-"));
		let fixture = 0;
		const stale = (mode: string, dispatchId?: string) => {
			const eventDir = join(dir, `${mode}-${fixture++}`);
			const run = createOrchestrationRun({ eventDir, actor: "test", mode });
			if (dispatchId) run.record("subagent.started", { dispatchId });
			writeFileSync(join(eventDir, "active.json"), JSON.stringify({ pid: 2147483647 }));
			return summarizeOrchestrationRun(eventDir)!;
		};
		expect(stale("CHAIN")).toMatchObject({ status: "stale", recoveryAction: "chain-resume" });
		expect(stale("PIPELINE")).toMatchObject({ status: "stale", recoveryAction: "pipeline-resume" });
		expect(stale("PLAN", "builder-sa1-resume")).toMatchObject({ status: "stale", recoveryAction: "subagent-resume", recoveryDispatchId: "builder-sa1-resume" });
		expect(stale("PLAN", "../unsafe")).toMatchObject({ status: "stale", recoveryAction: "inspect" });
	});
});
