import { describe, expect, test } from "bun:test";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readPipelineSnapshot, writePipelineSnapshot } from "../lib/pipeline-state.ts";

const phase = { name: "understand", status: "active" as const, summary: "clarify", dispatchCount: 0, lastDispatchSuccess: false };

describe("durable pipeline state", () => {
	test("round-trips a versioned snapshot atomically", () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-pi-pipeline-"));
		writePipelineSnapshot(dir, { pipeline: "plan-build", currentPhaseIndex: 0, taskSummary: "task", accContext: "context", planOutput: "", reviewOutput: "", reviewLoopCount: 0, phases: [phase] });
		expect(readPipelineSnapshot(dir)).toMatchObject({ pipeline: "plan-build", currentPhaseIndex: 0, phases: [phase] });
	});

	test("rejects malformed, wrong-version, and symlink snapshots", () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-pi-pipeline-"));
		writeFileSync(join(dir, "pipeline-state.json"), JSON.stringify({ version: 2 }));
		expect(readPipelineSnapshot(dir)).toBeUndefined();
		const target = join(dir, "target.json");
		writeFileSync(target, JSON.stringify({ version: 1 }));
		const linkDir = mkdtempSync(join(tmpdir(), "agent-pi-pipeline-link-"));
		symlinkSync(target, join(linkDir, "pipeline-state.json"));
		expect(readPipelineSnapshot(linkDir)).toBeUndefined();
	});
});
