import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrationRun } from "../lib/orchestration-run.ts";
import { listOrchestrationRuns, summarizeOrchestrationRun } from "../lib/orchestration-query.ts";

describe("orchestration query", () => {
	test("summarizes persisted run events", () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-pi-query-"));
		const run = createOrchestrationRun({ eventDir: join(dir, "run-1"), actor: "test", parentRunId: "parent-1" });
		run.record("dispatch.started", { launchId: "one" });
		run.finish("succeeded", { exitCode: 0 });
		const summary = summarizeOrchestrationRun(run.eventDir!);
		expect(summary).toMatchObject({ runId: run.runId, parentRunId: "parent-1", actor: "test", status: "succeeded", eventCount: 3 });
	});

	test("ignores missing roots and respects run id filtering", () => {
		const cwd = mkdtempSync(join(tmpdir(), "agent-pi-query-"));
		mkdirSync(join(cwd, ".pi", "agent-sessions", "compositions", "not-a-run"), { recursive: true });
		expect(listOrchestrationRuns(cwd)).toEqual([]);
		expect(listOrchestrationRuns(cwd, { runId: "../escape" })).toEqual([]);
	});
});
