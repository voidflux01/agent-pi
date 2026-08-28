// ABOUTME: Tests for PLAN and SPEC system prompt templates.
// ABOUTME: Validates that prompts contain expected keywords for their workflows.

import { describe, it, expect } from "vitest";
import { PLAN_PROMPT, SPEC_PROMPT, buildPlanPrompt } from "../lib/mode-prompts.ts";

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

	it("makes reconnaissance Phase 1 for multi-file work", () => {
		expect(PLAN_PROMPT).toContain("reconnaissance is Phase 1");
		expect(PLAN_PROMPT).toContain("may run before the task list exists");
	});

	it("provides guidance on skipping scouts for simple tasks", () => {
		expect(PLAN_PROMPT).toContain("Simple one-file fixes");
		expect(PLAN_PROMPT).toContain("do not spawn scouts");
	});

	it("instructs to synthesize scout findings", () => {
		expect(PLAN_PROMPT.toLowerCase()).toContain("synthesize");
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
});
