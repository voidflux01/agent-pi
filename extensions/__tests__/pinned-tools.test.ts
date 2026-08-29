// ABOUTME: First-turn orchestration tools stay visible when another extension narrows the surface.
import { describe, expect, it } from "vitest";
import { pinOrchestrationTools, PINNED_ORCHESTRATION_TOOLS } from "../lib/pinned-tools.ts";
import { extensionTerminalTitle } from "../lib/themeMap.ts";
import { herdrWorkerLabel } from "../lib/herdr-client.ts";

describe("pinOrchestrationTools", () => {
	it("adds missing orchestration tools that exist on the full surface", () => {
		const full = ["read", "write", "edit", "bash", "set_mode", "tasks", "subagent_create", "grep"];
		expect(pinOrchestrationTools(["read", "write", "edit", "bash"], full)).toEqual([
			"read", "write", "edit", "bash", "set_mode", "tasks", "subagent_create",
		]);
	});

	it("does not invent tools the session never had", () => {
		expect(pinOrchestrationTools(["read"], ["read", "write"])).toEqual(["read"]);
	});

	it("is a no-op when the tools are already present", () => {
		const active = ["read", "set_mode", "tasks"];
		expect(pinOrchestrationTools(active, [...active, "grep"])).toEqual(active);
	});

	it("pins the PLAN/scout entry points", () => {
		expect(PINNED_ORCHESTRATION_TOOLS).toContain("set_mode");
		expect(PINNED_ORCHESTRATION_TOOLS).toContain("subagent_create");
		expect(PINNED_ORCHESTRATION_TOOLS).toContain("show_plan");
		expect(PINNED_ORCHESTRATION_TOOLS).toContain("tasks");
	});
});

describe("extensionTerminalTitle", () => {
	it("prefers PI_PANE_TITLE over the first -e flag", () => {
		expect(extensionTerminalTitle(
			["pi", "-e", "/ext/security-guard.ts"],
			{ PI_PANE_TITLE: "scout-sa1" },
		)).toBe("π - scout-sa1");
	});

	it("uses PI_AGENT_NAME for subagents without a pane title", () => {
		expect(extensionTerminalTitle(
			["pi", "-e", "/ext/security-guard.ts"],
			{ PI_SUBAGENT: "1", PI_AGENT_NAME: "sa1" },
		)).toBe("π - sa1");
	});

	it("falls back to the first extension name", () => {
		expect(extensionTerminalTitle(["pi", "-e", "/ext/security-guard.ts"], {})).toBe("π - security-guard");
	});
});

describe("herdrWorkerLabel", () => {
	it("joins role and id", () => {
		expect(herdrWorkerLabel("SCOUT", "sa1")).toBe("SCOUT-sa1");
		expect(herdrWorkerLabel(" builder ", "tm-1")).toBe("builder-tm-1");
		expect(herdrWorkerLabel("planner", "pipeline-planner-0-1-mteeuoc4")).toBe("pipeline-planner-0-1-mteeuoc4");
	});
});
