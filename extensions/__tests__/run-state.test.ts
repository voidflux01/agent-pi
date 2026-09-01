import { describe, expect, it } from "vitest";
import { isResumableRunStatus, isTerminalRunStatus, normalizeRunStatus } from "../lib/run-state.ts";

describe("run state normalization", () => {
	it.each([
		["pending", "queued"],
		["dispatched", "queued"],
		["working", "running"],
		["blocked", "waiting"],
		["done", "succeeded"],
		["error", "failed"],
		["stopped", "cancelled"],
	])("maps legacy status %s to %s", (input, expected) => {
		expect(normalizeRunStatus(input)).toBe(expected);
	});

	it("does not treat unknown values as terminal", () => {
		expect(normalizeRunStatus("future-state")).toBe("unknown");
		expect(isTerminalRunStatus("future-state")).toBe(false);
	});

	it("marks failed runs resumable while terminal success is not resumable", () => {
		expect(isResumableRunStatus("failed")).toBe(true);
		expect(isResumableRunStatus("completed")).toBe(false);
	});
});
