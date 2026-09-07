// ABOUTME: Tests for the pure per-type dispatch gate used by subagent tools.

import { describe, expect, it } from "vitest";

import { decideTypeDispatch, type TypeWorkerSnapshot } from "../lib/subagent-type-gate.ts";

const worker = (overrides: Partial<TypeWorkerSnapshot>): TypeWorkerSnapshot => ({
	id: 7,
	name: "planner",
	status: "done",
	...overrides,
});

describe("decideTypeDispatch", () => {
	it("spawns when no worker is running", () => {
		expect(decideTypeDispatch([], "planner").action).toBe("spawn");
		expect(decideTypeDispatch([worker({ status: "done" }), worker({ status: "error", id: 8 })], "planner").action).toBe("spawn");
	});

	it("blocks when a same-type worker is running (case-insensitive)", () => {
		const decision = decideTypeDispatch([worker({ status: "running" })], "PLANNER");
		expect(decision.action).toBe("blocked-type-running");
		if (decision.action !== "blocked-type-running") return;
		expect(decision.existingId).toBe(7);
		expect(decision.message).toContain("SA7 (planner) of the same type is already running");
		expect(decision.message).toContain("force: true");
	});

	it("allows spawning after done/error states", () => {
		expect(decideTypeDispatch([worker({ status: "error" })], "PLANNER").action).toBe("spawn");
		expect(decideTypeDispatch([worker({ status: "done" })], "PLANNER").action).toBe("spawn");
	});

	it("reports the latest running match id among multiple workers", () => {
		const decision = decideTypeDispatch([
			worker({ id: 3, name: "BUILDER", status: "running" }),
			worker({ id: 9, name: "builder", status: "running" }),
		], "Builder");
		expect(decision.action).toBe("blocked-type-running");
		if (decision.action !== "blocked-type-running") return;
		expect(decision.existingId).toBe(9);
	});

	it("ignores running workers of other types", () => {
		expect(decideTypeDispatch([worker({ name: "scout", status: "running" })], "planner").action).toBe("spawn");
	});
});
