import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrationRun } from "../lib/orchestration-run.ts";
import { buildOrchestrationTopology, listOrchestrationRuns, readOrchestrationEvents, summarizeOrchestrationModes, summarizeOrchestrationRun } from "../lib/orchestration-query.ts";

describe("orchestration query", () => {
	test("summarizes persisted run events", () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-pi-query-"));
		const run = createOrchestrationRun({ eventDir: join(dir, "run-1"), actor: "test", mode: "PLAN", parentRunId: "parent-1" });
		run.record("tool.started", { toolName: "write", toolCallId: "tool-1" });
		run.record("tool.completed", { toolName: "write", toolCallId: "tool-1", status: "succeeded" });
		run.record("dispatch.started", { launchId: "one" });
		run.recordUsage({ totalTokens: 10, costUsd: 0.01 });
		run.record("dispatch.completed", { failure: "timeout" });
		run.record("workspace.changed", { changedFiles: ["src/a.ts"] });
		run.record("verification.completed", { status: "PASS", passed: 2, failed: 0 });
		run.finish("succeeded", { exitCode: 0 });
		const summary = summarizeOrchestrationRun(run.eventDir!);
		expect(summary).toMatchObject({ runId: run.runId, parentRunId: "parent-1", actor: "test", mode: "PLAN", status: "succeeded", toolName: "write", toolStatus: "succeeded", eventCount: 9, totalTokens: 10, costUsd: 0.01, failureCause: "timeout", verificationStatus: "PASS", verificationPassed: 2, verificationFailed: 0, changedFiles: ["src/a.ts"] });
		expect(summary).toMatchObject({ recovery: "terminal", lastEventType: "run.succeeded" });
		expect(readOrchestrationEvents(run.eventDir!, 2).map(event => event.type)).toEqual(["verification.completed", "run.succeeded"]);
	});

	test("ignores missing roots and respects run id filtering", () => {
		const cwd = mkdtempSync(join(tmpdir(), "agent-pi-query-"));
		mkdirSync(join(cwd, ".pi", "agent-sessions", "compositions", "not-a-run"), { recursive: true });
		expect(listOrchestrationRuns(cwd)).toEqual([]);
		expect(listOrchestrationRuns(cwd, { runId: "../escape" })).toEqual([]);
	});

	test("marks a successful run without a verification receipt as unverified", () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-pi-query-unverified-"));
		const run = createOrchestrationRun({ eventDir: join(dir, "run-1"), actor: "test", mode: "NORMAL" });
		run.finish("succeeded");
		expect(summarizeOrchestrationRun(run.eventDir!)).toMatchObject({ status: "succeeded", verificationStatus: "UNVERIFIED" });
	});

	test("filters runs by coordination mode before applying the display limit", () => {
		const cwd = mkdtempSync(join(tmpdir(), "agent-pi-query-modes-"));
		const root = join(cwd, ".pi", "agent-sessions", "compositions");
		mkdirSync(root, { recursive: true });
		for (const mode of ["NORMAL", "PLAN", "SPEC"]) {
			const run = createOrchestrationRun({ eventDir: join(root, mode), actor: "test", mode });
			run.finish("succeeded");
		}
		expect(listOrchestrationRuns(cwd, { mode: "plan" }).map(run => run.mode)).toEqual(["PLAN"]);
		expect(listOrchestrationRuns(cwd, { mode: "SPEC", limit: 1 })).toHaveLength(1);
		expect(listOrchestrationRuns(cwd, { mode: "missing" })).toEqual([]);
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

	test("aggregates bounded run metrics by mode", () => {
		const base = (mode: string, status: any, durationMs: number, totalTokens: number) => ({ runId: `${mode}-${status}`, actor: "test", mode, status, durationMs, totalTokens, costUsd: 0.01, eventCount: 1, eventDir: "/tmp/run" });
		const metrics = summarizeOrchestrationModes([
			base("plan", "succeeded", 2_000, 100), base("PLAN", "failed", 4_000, 200), base("SPEC", "stale", 1_000, 50),
		]);
		expect(metrics.PLAN).toMatchObject({ runs: 2, succeeded: 1, failed: 1, durationMs: 6_000, totalTokens: 300 });
		expect(metrics.SPEC).toMatchObject({ runs: 1, stale: 1 });
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
		expect(stale("NORMAL")).toMatchObject({ status: "stale", recoveryAction: "inspect" });
		expect(stale("PLAN", "builder-sa1-resume")).toMatchObject({ status: "stale", recoveryAction: "subagent-resume", recoveryDispatchId: "builder-sa1-resume" });
		expect(stale("PLAN", "../unsafe")).toMatchObject({ status: "stale", recoveryAction: "inspect" });
	});

	test("recovers measured usage from an interrupted run's last usage event", () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-pi-interrupted-"));
		const eventDir = join(dir, "stale-run");
		const run = createOrchestrationRun({ eventDir, actor: "test", mode: "NORMAL" });
		run.recordUsage({ totalTokens: 321, costUsd: 0.0456 });
		writeFileSync(join(eventDir, "active.json"), JSON.stringify({ pid: 2147483647 }));
		const summary = summarizeOrchestrationRun(eventDir)!;
		expect(summary.status).toBe("stale");
		expect(summary).toMatchObject({ totalTokens: 321, costUsd: 0.0456 });
	});
});
