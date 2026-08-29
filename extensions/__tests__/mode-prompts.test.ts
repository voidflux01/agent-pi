// ABOUTME: Tests for PLAN and SPEC system prompt templates.
// ABOUTME: Validates that prompts contain expected keywords for their workflows.

import { describe, it, expect } from "vitest";
import { GRILL_ME_SECTION, PLAN_PROMPT, SPEC_PROMPT, buildPlanPrompt } from "../lib/mode-prompts.ts";

describe("GRILL_ME_SECTION", () => {
	it("uses ask_user once, not a separate interview", () => {
		expect(GRILL_ME_SECTION).toContain("ask_user");
		expect(GRILL_ME_SECTION).toContain("recommended option first");
		expect(GRILL_ME_SECTION).toContain("Do not call set_mode just to ask");
		expect(GRILL_ME_SECTION).toContain("Phase 2's planning/questions.md");
		expect(GRILL_ME_SECTION).not.toContain("Look up facts yourself");
		expect(GRILL_ME_SECTION).not.toMatch(/[❓➡️🔥]/u);
	});
});

describe("PLAN_PROMPT", () => {
	it("is a non-empty string", () => {
		expect(typeof PLAN_PROMPT).toBe("string");
		expect(PLAN_PROMPT.length).toBeGreaterThan(0);
	});

	it("contains 'plan'", () => {
		expect(PLAN_PROMPT.toLowerCase()).toContain("plan");
	});

	it("contains 'approve'", () => {
		expect(PLAN_PROMPT.toLowerCase()).toContain("approve");
	});

	it("contains 'implement'", () => {
		expect(PLAN_PROMPT.toLowerCase()).toContain("implement");
	});

	it("does not mention unavailable Commander tools", () => {
		expect(PLAN_PROMPT).not.toContain("commander_task");
	});

	it("contains '.context/todo.md'", () => {
		expect(PLAN_PROMPT).toContain(".context/todo.md");
	});

	it("keeps scout-then-plan steps, with grill as enhancement only", () => {
		expect(PLAN_PROMPT).toContain("Enhancement only");
		expect(PLAN_PROMPT).toContain("do not skip, reorder, or replace this mode's workflow");
		expect(PLAN_PROMPT).toContain("1. Scout if you cannot name the files to change");
		expect(PLAN_PROMPT).toContain("blocked until show_plan is approved");
		expect(PLAN_PROMPT.indexOf("1. Scout if you cannot name the files to change")).toBeLessThan(PLAN_PROMPT.indexOf("2. Write"));
		expect(PLAN_PROMPT.indexOf("## Scout")).toBeLessThan(PLAN_PROMPT.indexOf("## Grill-me"));
		expect(PLAN_PROMPT).not.toContain("grill_record_turn");
	});
});

describe("buildPlanPrompt — optional Commander", () => {
	it("adds Commander instructions only when connected", () => {
		expect(buildPlanPrompt(false)).not.toContain("commander_task");
		expect(buildPlanPrompt(true)).toContain("commander_task");
		expect(buildPlanPrompt(true)).toContain("ALWAYS");
	});
});

describe("PLAN_PROMPT — scout-based context gathering", () => {
	it("instructs spawning scout subagents for context gathering", () => {
		expect(PLAN_PROMPT.toLowerCase()).toContain("scout");
	});

	it("keeps scout count complexity-driven", () => {
		expect(PLAN_PROMPT).toContain("at most one");
		expect(PLAN_PROMPT).toContain("Never spawn four scouts by default");
	});

	it("uses subagent_create for scout findings", () => {
		expect(PLAN_PROMPT).toContain("read-only scout");
		expect(PLAN_PROMPT).toContain("subagent_create");
		expect(PLAN_PROMPT).toContain('name: "scout"');
		expect(PLAN_PROMPT).toContain("file paths only");
		expect(PLAN_PROMPT).not.toContain("dispatch_agent");
	});

	it("scouts only when the files to change are not already known", () => {
		expect(PLAN_PROMPT).toContain("Do not spawn a scout just because PLAN is active");
		expect(PLAN_PROMPT).toContain("If the tree is small and the paths are already known, read them yourself");
		expect(PLAN_PROMPT).toContain("may run before the task list exists");
		expect(PLAN_PROMPT).not.toContain("scout is required");
	});

	it("does not tell PLAN to skip scouts the way NORMAL does", () => {
		expect(PLAN_PROMPT).not.toContain("do not spawn scouts");
		expect(PLAN_PROMPT).not.toContain("Simple one-file fixes");
	});

	it("instructs to synthesize scout findings", () => {
		expect(PLAN_PROMPT.toLowerCase()).toContain("synthesize");
	});

	it("makes each scout call block until RESULT", () => {
		expect(PLAN_PROMPT).toContain("blocks until that scout RESULT returns");
		expect(PLAN_PROMPT).toContain("Do not scan those areas yourself");
		expect(PLAN_PROMPT).not.toContain("Do not wait for a fixed scout count");
	});

});

describe("PLAN_PROMPT — structured plan format", () => {
	it("teaches phased plan structure", () => {
		expect(PLAN_PROMPT).toContain("Phase");
		expect(PLAN_PROMPT).toContain("Context");
	});

	it("includes file action indicators", () => {
		expect(PLAN_PROMPT).toContain("New file");
		expect(PLAN_PROMPT).toContain("Modify");
		expect(PLAN_PROMPT).toContain("Test first");
	});

	it("includes Critical Files section template", () => {
		expect(PLAN_PROMPT).toContain("Critical Files");
	});

	it("includes Verification section template", () => {
		expect(PLAN_PROMPT).toContain("Verification");
	});

	it("includes Reusable Components section template", () => {
		expect(PLAN_PROMPT).toContain("Reusable Components");
	});

	it("teaches Why justification for phases", () => {
		expect(PLAN_PROMPT).toContain("Why");
		expect(PLAN_PROMPT).toContain("Why");
	});

	it("emphasizes phases over flat steps", () => {
		expect(PLAN_PROMPT).toContain("Phase");
	});
});


describe("orchestration task discipline", () => {
	it("requires task setup before execution in PLAN", () => {
		expect(PLAN_PROMPT).toContain("Task discipline (required in this mode)");
		expect(PLAN_PROMPT).toContain("tasks new-list");
		expect(PLAN_PROMPT).toContain("tasks toggle");
	});

	it("requires task setup before execution in SPEC", () => {
		expect(SPEC_PROMPT).toContain("Task discipline (required in this mode)");
		expect(SPEC_PROMPT).toContain("tasks add");
	});
});

describe("SPEC_PROMPT — Commander-first enforcement", () => {
	it("contains 'ALWAYS' for Commander usage", () => {
		expect(SPEC_PROMPT).toContain("ALWAYS");
	});
});

describe("SPEC_PROMPT", () => {
	it("is a non-empty string", () => {
		expect(typeof SPEC_PROMPT).toBe("string");
		expect(SPEC_PROMPT.length).toBeGreaterThan(0);
	});

	it("contains 'context-os'", () => {
		expect(SPEC_PROMPT.toLowerCase()).toContain("context-os");
	});

	it("contains 'spec'", () => {
		expect(SPEC_PROMPT.toLowerCase()).toContain("spec");
	});

	it("contains 'requirements.md'", () => {
		expect(SPEC_PROMPT).toContain("requirements.md");
	});

	it("contains 'commander_mailbox'", () => {
		expect(SPEC_PROMPT).toContain("commander_mailbox");
	});

	it("keeps Phase 2 questions.md, with grill as enhancement only", () => {
		expect(SPEC_PROMPT).toContain("Enhancement only");
		expect(SPEC_PROMPT).toContain("Generate 4-8 numbered clarifying questions");
		expect(SPEC_PROMPT).toContain("Always include a visual assets request");
		expect(SPEC_PROMPT).toContain("Always include a reusability check");
		expect(SPEC_PROMPT).toContain("planning/questions.md");
		expect(SPEC_PROMPT.indexOf("Phase 1: Initialize Spec")).toBeLessThan(SPEC_PROMPT.indexOf("Phase 2: Shape Requirements"));
		expect(SPEC_PROMPT.indexOf("Phase 2: Shape Requirements")).toBeLessThan(SPEC_PROMPT.indexOf("## Grill-me"));
		expect(SPEC_PROMPT).toContain("blocked until show_spec is approved");
	});
});
