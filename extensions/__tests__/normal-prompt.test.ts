// ABOUTME: Tests for buildNormalPrompt — the NORMAL mode system prompt that teaches autonomous mode selection.
// ABOUTME: Validates mode classification guidance and chain/pipeline status reporting.

import { describe, it, expect } from "vitest";
import { buildNormalPrompt } from "../lib/mode-prompts.ts";

describe("buildNormalPrompt", () => {
	it("is a non-empty string", () => {
		const result = buildNormalPrompt({ activeChain: null, activePipeline: null });
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});

	it("contains 'set_mode'", () => {
		const result = buildNormalPrompt({ activeChain: null, activePipeline: null });
		expect(result).toContain("set_mode");
	});

	it("contains all 6 mode names", () => {
		const result = buildNormalPrompt({ activeChain: null, activePipeline: null });
		for (const mode of ["NORMAL", "PLAN", "SPEC", "TEAM", "CHAIN", "PIPELINE"]) {
			expect(result).toContain(mode);
		}
	});

	it("with activeChain set, contains chain name", () => {
		const result = buildNormalPrompt({ activeChain: "plan-build-review", activePipeline: null });
		expect(result).toContain("plan-build-review");
	});

	it("with activeChain: null, contains guidance about /chain", () => {
		const result = buildNormalPrompt({ activeChain: null, activePipeline: null });
		expect(result).toContain("/chain");
	});

	it("with activePipeline set, contains pipeline name", () => {
		const result = buildNormalPrompt({ activeChain: null, activePipeline: "full-feature" });
		expect(result).toContain("full-feature");
	});

	it("with activePipeline: null, contains guidance about /pipeline", () => {
		const result = buildNormalPrompt({ activeChain: null, activePipeline: null });
		expect(result).toContain("/pipeline");
	});

	it("contains low-ceremony direct-work guidance", () => {
		const result = buildNormalPrompt({ activeChain: null, activePipeline: null });
		expect(result.toLowerCase()).toContain("work directly");
		expect(result.toLowerCase()).toContain("do not call set_mode");
		expect(result).toContain("Orchestration is opt-in");
		expect(result).toContain("PI_TASKS_STRICT=0");
	});

	it("adds grill as enhancement without replacing direct work", () => {
		const result = buildNormalPrompt({ activeChain: null, activePipeline: null });
		expect(result).toContain("Enhancement only");
		expect(result).toContain("do not skip, reorder, or replace this mode's workflow");
		expect(result).toContain("ask_user");
		expect(result).toContain("Do not call set_mode just to ask");
		expect(result).not.toContain("grill_record_turn");
	});
});

describe("buildNormalPrompt — Scout delegation", () => {
	it("instructs spawning a scout via subagent_create", () => {
		const result = buildNormalPrompt({ activeChain: null, activePipeline: null });
		expect(result).toContain("Optional scout");
		expect(result).toContain("subagent_create");
		expect(result).toContain('name: "scout"');
	});

	it("does not depend on a pre-spawned scout id", () => {
		const result = buildNormalPrompt({ activeChain: null, activePipeline: null });
		expect(result).not.toContain("subagent_continue");
		expect(result).not.toContain("SA1");
	});

	it("skips scouts for simple lookups and edits", () => {
		const result = buildNormalPrompt({ activeChain: null, activePipeline: null });
		expect(result.toLowerCase()).toContain("quick lookup");
		expect(result.toLowerCase()).toContain("simple edit");
	});

	it("mentions fallback if scout errors", () => {
		const result = buildNormalPrompt({ activeChain: null, activePipeline: null });
		expect(result.toLowerCase()).toContain("continue directly");
	});

	it("supports progressive escalation when direct debugging gets stuck", () => {
		const result = buildNormalPrompt({ activeChain: null, activePipeline: null });
		expect(result).toContain("reassess as evidence accumulates");
		expect(result).toContain("3-5 focused inspection calls");
		expect(result).toContain("two failed root-cause hypotheses");
		expect(result).toContain("even if the task initially looked simple");
		expect(result).toContain("capability choice, not a difficulty ladder");
		expect(result).toContain("Do not climb through modes one by one");
		expect(result).toContain("new evidence changes the capability requirement");
		expect(result).toContain("a scout that resolves uncertainty is a valid reason to remain in NORMAL");
	});

	it("tells the parent the scout call blocks until RESULT", () => {
		const result = buildNormalPrompt({ activeChain: null, activePipeline: null });
		expect(result).toContain("blocks until the scout RESULT returns");
		expect(result).toContain("Do not scan the same area yourself");
		expect(result).toContain("Do not read the archived transcript");
	});

	it("reassesses scout needs for each new user request", () => {
		const result = buildNormalPrompt({ activeChain: null, activePipeline: null });
		expect(result).toContain("every new user request");
		expect(result).toContain("historical evidence");
		expect(result).toContain("dispatch a fresh read-only SCOUT");
	});
});
