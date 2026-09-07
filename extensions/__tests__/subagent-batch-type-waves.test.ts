// ABOUTME: Pure tests for the implicit per-type resource keys injected into
// ABOUTME: subagent batch scheduling — same-type defs must never share a wave.

import { describe, expect, it } from "vitest";

import { scheduleResourceWaves } from "../lib/resource-scheduler.ts";
import { withTypeResourceKeys } from "../subagent-widget.ts";

describe("withTypeResourceKeys + scheduleResourceWaves", () => {
	it("injects an implicit per-type resource key per def", () => {
		const defs = [{ name: "BUILDER", task: "a" }, { name: "scout", resources: ["db"] }];
		expect(withTypeResourceKeys(defs)).toEqual([
			{ name: "BUILDER", task: "a", resources: ["agent-type:builder"] },
			{ name: "scout", resources: ["db", "agent-type:scout"] },
		]);
	});

	it("schedules two same-type defs into different waves", () => {
		const defs = [
			{ name: "BUILDER", task: "one", resources: [] as string[] },
			{ name: "BUILDER", task: "two", resources: [] as string[] },
		];
		const waves = scheduleResourceWaves(withTypeResourceKeys(defs), defs.length);
		const waveOf = (index: number) => waves.findIndex((wave) => wave.includes(index));
		expect(waves.length).toBe(2);
		expect(waveOf(0)).not.toBe(waveOf(1));
	});

	it("keeps distinct-type defs concurrent in one wave", () => {
		const defs = [
			{ name: "BUILDER", task: "one", resources: [] as string[] },
			{ name: "SCOUT", task: "two", resources: [] as string[] },
		];
		const waves = scheduleResourceWaves(withTypeResourceKeys(defs), defs.length);
		expect(waves.length).toBe(1);
		expect(waves[0]).toEqual([0, 1]);
	});

	it("keeps same-type defs apart even with shared declared resources", () => {
		const defs = [
			{ name: "TESTER", task: "one", resources: ["db"] },
			{ name: "tester", task: "two", resources: ["db"] },
		];
		const waves = scheduleResourceWaves(withTypeResourceKeys(defs), defs.length);
		const waveOf = (index: number) => waves.findIndex((wave) => wave.includes(index));
		expect(waveOf(0)).not.toBe(waveOf(1));
	});
});
