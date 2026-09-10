import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decideIteration, loadIteration, recordIteration, type IterationObservation } from "../lib/iteration-controller.ts";

const fingerprint = "a".repeat(64);
function observation(status: IterationObservation["status"], attempt: number, failureSignature = "compile error"): IterationObservation {
	return { runId: `run-${attempt}`, mode: "NORMAL", contractFingerprint: fingerprint, status, attempt, failure: status === "FAIL" ? "implementation" : undefined, failureSignature: status === "FAIL" ? failureSignature : undefined, evidenceRefs: ["test-output"], changedFiles: [], createdAt: new Date().toISOString() };
}

describe("iteration controller", () => {
	test("repairs once, replans repeated failures, and completes on PASS", () => {
		const first = observation("FAIL", 1);
		const second = observation("FAIL", 2);
		expect(decideIteration({ observation: first, previous: [], maxIterations: 3, repairAvailable: true }).action).toBe("REPAIR");
		expect(decideIteration({ observation: second, previous: [first], maxIterations: 3, repairAvailable: true })).toMatchObject({ action: "REPLAN", nextMode: "PLAN", requiresApproval: true });
		expect(decideIteration({ observation: observation("PASS", 3), previous: [first, second], maxIterations: 3, repairAvailable: true }).action).toBe("COMPLETE");
	});

	test("requirements and unsafe outcomes fail closed", () => {
		const requirements = { ...observation("FAIL", 1), failure: "requirements" as const };
		const environment = { ...observation("FAIL", 1), failure: "environment" as const };
		expect(decideIteration({ observation: requirements, previous: [], maxIterations: 3, repairAvailable: true })).toMatchObject({ action: "REPLAN", nextMode: "SPEC", requiresApproval: true });
		expect(decideIteration({ observation: environment, previous: [], maxIterations: 3, repairAvailable: true }).action).toBe("BLOCKED");
		expect(decideIteration({ observation: observation("FAIL", 1), previous: [], maxIterations: 3, repairAvailable: true, risk: "high" }).action).toBe("ESCALATE");
	});

	test("persists bounded redacted workspace ledger", () => {
		const cwd = mkdtempSync(join(tmpdir(), "iteration-controller-"));
		for (let attempt = 1; attempt <= 25; attempt++) recordIteration(cwd, { ...observation("FAIL", attempt, `token=secret-${attempt}`), runId: `run-${attempt}` });
		const history = loadIteration(cwd, fingerprint);
		expect(history).toHaveLength(20);
		expect(JSON.stringify(history)).not.toContain("secret-");
		writeFileSync(join(cwd, ".pi/workflow/iterations", `${"b".repeat(64)}.json`), "broken");
		expect(loadIteration(cwd, "b".repeat(64))).toEqual([]);
	});
});
