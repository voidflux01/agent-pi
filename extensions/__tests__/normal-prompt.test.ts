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

	it("defines structural entry rules for orchestration modes", () => {
		const result = buildNormalPrompt({ activeChain: null, activePipeline: null });
		expect(result).toContain("TEAM for independent workstreams");
		expect(result).toContain("PIPELINE for three or more ordered phases");
		expect(result).toContain("existing CHAIN only when it is an exact match");
		expect(result).toContain("User constraints");
	});

	it("with activeChain set, contains chain name", () => {
		const result = buildNormalPrompt({ activeChain: "plan-build-review", activePipeline: null });
		expect(result).toContain("plan-build-review");
	});

	it("with activeChain: null, contains CHAIN mode guidance", () => {
		const result = buildNormalPrompt({ activeChain: null, activePipeline: null });
		expect(result).toContain("set_mode CHAIN");
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
		expect(result).toContain("Choose the lightest sufficient mode");
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

	it("applies the acceptance and review contract to NORMAL", () => {
		const result = buildNormalPrompt({ activeChain: null, activePipeline: null });
		expect(result).toContain("Objective, Scope, Acceptance Criteria");
		expect(result).toContain("Critical/High");
	});
});

describe("buildNormalPrompt — Scout delegation", () => {
	it("instructs spawning a scout via subagent_create", () => {
		const result = buildNormalPrompt({ activeChain: null, activePipeline: null });
		expect(result).toContain("one bounded read-only scout");
	});

	it("does not depend on a pre-spawned scout id", () => {
		const result = buildNormalPrompt({ activeChain: null, activePipeline: null });
		expect(result).not.toContain("subagent_continue");
		expect(result).not.toContain("SA1");
	});

	it("keeps simple work direct and escalates only when needed", () => {
		const result = buildNormalPrompt({ activeChain: null, activePipeline: null });
		expect(result).toContain("Start directly");
		expect(result).toContain("Dispatch researcher only when external facts are required");
	});

	it("supports progressive escalation when direct debugging gets stuck", () => {
		const result = buildNormalPrompt({ activeChain: null, activePipeline: null });
		expect(result).toContain("3-5 focused inspection calls");
		expect(result).toContain("two failed root-cause hypotheses");
		expect(result).toContain("verified terminal result");
		expect(result).toContain("If the cause is still unclear, dispatch one scout");
		expect(result).toContain("stop and reassess");
	});

	it("tells the parent the scout call blocks until RESULT", () => {
		const result = buildNormalPrompt({ activeChain: null, activePipeline: null });
		expect(result).not.toContain("RESEARCH_ROUTING_PROMPT");
		expect(result).not.toContain("subagent_create_batch");
	});

	it("reassesses scout needs for each new user request", () => {
		const result = buildNormalPrompt({ activeChain: null, activePipeline: null });
		expect(result).toContain("reassess");
		expect(result).toContain("one scout");
	});
});
