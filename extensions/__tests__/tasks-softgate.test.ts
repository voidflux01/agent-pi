import { describe, expect, it } from "bun:test";
import { claimGateTask, decideGateClaim } from "../tasks.ts";

describe("tasks gate decision (soft-gate v2)", () => {
	it("auto-claims newest non-done when nothing is in progress", () => {
		const d = decideGateClaim([
			{ id: 1, status: "done" },
			{ id: 2, status: "idle" },
			{ id: 3, status: "idle" },
		]);
		expect(d.block).toBe(false);
		expect(d.claimId).toBe(3);
	});

	it("applies the auto-claim to the task state", () => {
		const tasks = [
			{ id: 1, status: "done" },
			{ id: 2, status: "idle" },
			{ id: 3, status: "idle" },
		];

		expect(claimGateTask(tasks)).toBe(3);
		expect(tasks).toEqual([
			{ id: 1, status: "done" },
			{ id: 2, status: "idle" },
			{ id: 3, status: "inprogress" },
		]);
	});

	it("no claim needed when a task is already in progress", () => {
		const d = decideGateClaim([
			{ id: 1, status: "inprogress" },
			{ id: 2, status: "idle" },
		]);
		expect(d.block).toBe(false);
		expect(d.claimId).toBeUndefined();
	});

	it("never blocks; all-done just passes with no claim", () => {
		const d = decideGateClaim([{ id: 1, status: "done" }]);
		expect(d.block).toBe(false);
		expect(d.claimId).toBeUndefined();
	});

	it("empty list passes without claim", () => {
		expect(decideGateClaim([])).toEqual({ block: false });
	});
});
