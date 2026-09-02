import { describe, expect, test } from "bun:test";
import { normalizeResourceKeys, scheduleResourceWaves } from "../lib/resource-scheduler.ts";

describe("resource-aware orchestration scheduling", () => {
	test("normalizes and bounds declared resource keys", () => {
		expect(normalizeResourceKeys([" Workspace ", "workspace", "", 4, "x".repeat(200)])).toEqual(["workspace", "x".repeat(160)]);
	});

	test("serializes overlapping resources while preserving independent parallelism", () => {
		const waves = scheduleResourceWaves([
			{ resources: ["file:a"] },
			{ resources: ["file:a"] },
			{ resources: ["file:b"] },
			{},
		], 3);
		expect(waves).toEqual([[0, 2, 3], [1]]);
	});

	test("respects the concurrency limit deterministically", () => {
		expect(scheduleResourceWaves([{}, {}, {}, {}], 2)).toEqual([[0, 1], [2, 3]]);
	});
});
