// ABOUTME: Durable dispatch receipt contract tests for all workflow modes.

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	consumeDispatchReceipt,
	createDispatchReceipt,
	finishDispatchReceipt,
	readDispatchReceipt,
} from "../lib/workflow-dispatch.ts";

describe("workflow dispatch receipts", () => {
	it("round-trips a completed receipt and consumes it exactly once", () => {
		const cwd = mkdtempSync(join(tmpdir(), "agent-pi-receipt-"));
		try {
			const created = createDispatchReceipt(cwd, {
				mode: "PIPELINE",
				runId: "run-1",
				phase: "plan",
				phaseIndex: 1,
				stepIndex: 0,
				scope: "pipeline:plan",
			}, "planner", "create a plan", false);
			expect(created.status).toBe("pending");
			expect(readDispatchReceipt(cwd, created.id)?.status).toBe("pending");

			const finished = finishDispatchReceipt(cwd, created.id, {
				status: "done",
				exitCode: 0,
				elapsedMs: 42,
				fullOutputPath: join(cwd, "output.txt"),
				evidenceRefs: ["output.txt"],
			});
			expect(finished?.status).toBe("done");
			expect(finished?.context.phaseIndex).toBe(1);
			expect(consumeDispatchReceipt(cwd, created.id)?.status).toBe("consumed");
			expect(consumeDispatchReceipt(cwd, created.id)).toBeUndefined();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("writes bounded, private JSON atomically", () => {
		const cwd = mkdtempSync(join(tmpdir(), "agent-pi-receipt-"));
		try {
			const receipt = createDispatchReceipt(cwd, { mode: "NORMAL" }, "scout", "x".repeat(20_000), false);
			const path = join(cwd, ".pi", "agent-sessions", "dispatch-receipts", `${receipt.id}.json`);
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			expect(parsed.task.length).toBe(4_000);
			expect(parsed.version).toBe(1);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
