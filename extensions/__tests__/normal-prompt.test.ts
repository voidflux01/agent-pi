// ABOUTME: Tests for buildNormalPrompt — the NORMAL mode system prompt that teaches autonomous mode selection.
// ABOUTME: Validates mode classification guidance, Commander integration, and chain/pipeline status reporting.

import { describe, it, expect } from "vitest";
import { buildNormalPrompt, buildCommanderSection } from "../lib/mode-prompts.ts";

describe("buildNormalPrompt", () => {
	it("is a non-empty string", () => {
		const result = buildNormalPrompt({ commanderAvailable: false, activeChain: null, activePipeline: null });
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});

	it("contains 'set_mode'", () => {
		const result = buildNormalPrompt({ commanderAvailable: false, activeChain: null, activePipeline: null });
		expect(result).toContain("set_mode");
	});

	it("contains all 6 mode names", () => {
		const result = buildNormalPrompt({ commanderAvailable: false, activeChain: null, activePipeline: null });
		for (const mode of ["NORMAL", "PLAN", "SPEC", "TEAM", "CHAIN", "PIPELINE"]) {
			expect(result).toContain(mode);
		}
	});

	it("with commanderAvailable: true, contains commander_task", () => {
		const result = buildNormalPrompt({ commanderAvailable: true, activeChain: null, activePipeline: null });
		expect(result).toContain("commander_task");
	});

	it("with commanderAvailable: false, does NOT contain commander_task", () => {
		const result = buildNormalPrompt({ commanderAvailable: false, activeChain: null, activePipeline: null });
		expect(result).not.toContain("commander_task");
	});

	it("with activeChain set, contains chain name", () => {
		const result = buildNormalPrompt({ commanderAvailable: false, activeChain: "plan-build-review", activePipeline: null });
		expect(result).toContain("plan-build-review");
	});

	it("with activeChain: null, contains guidance about /chain", () => {
		const result = buildNormalPrompt({ commanderAvailable: false, activeChain: null, activePipeline: null });
		expect(result).toContain("/chain");
	});

	it("with activePipeline set, contains pipeline name", () => {
		const result = buildNormalPrompt({ commanderAvailable: false, activeChain: null, activePipeline: "full-feature" });
		expect(result).toContain("full-feature");
	});

	it("with activePipeline: null, contains guidance about /pipeline", () => {
		const result = buildNormalPrompt({ commanderAvailable: false, activeChain: null, activePipeline: null });
		expect(result).toContain("/pipeline");
	});

	it("contains low-ceremony direct-work guidance", () => {
		const result = buildNormalPrompt({ commanderAvailable: false, activeChain: null, activePipeline: null });
		expect(result.toLowerCase()).toContain("work directly");
		expect(result.toLowerCase()).toContain("do not call set_mode");
		expect(result).toContain("Orchestration is opt-in");
		expect(result).toContain("PI_TASKS_STRICT=0");
	});
});

describe("buildCommanderSection — Commander-first enforcement", () => {
	it("contains 'ALWAYS' to enforce Commander-first usage", () => {
		expect(buildCommanderSection()).toContain("ALWAYS");
	});
});

describe("buildNormalPrompt — Commander task guidance", () => {
	it("with commanderAvailable: true, mentions commander_mailbox in task guidance", () => {
		const result = buildNormalPrompt({ commanderAvailable: true, activeChain: null, activePipeline: null });
		expect(result).toContain("commander_mailbox");
	});

	it("with commanderAvailable: false, includes Commander-offline note", () => {
		const result = buildNormalPrompt({ commanderAvailable: false, activeChain: null, activePipeline: null });
		expect(result.toLowerCase()).toContain("commander");
		expect(result.toLowerCase()).toContain("offline");
	});
});

describe("buildCommanderSection", () => {
	it("returns a non-empty string", () => {
		const result = buildCommanderSection();
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});

	it("contains commander_task", () => {
		expect(buildCommanderSection()).toContain("commander_task");
	});

	it("contains commander_task", () => {
		expect(buildCommanderSection()).toContain("commander_task");
	});

	it("contains commander_mailbox", () => {
		expect(buildCommanderSection()).toContain("commander_mailbox");
	});
});

describe("buildNormalPrompt — Scout delegation", () => {
	it("instructs spawning a scout via subagent_create", () => {
		const result = buildNormalPrompt({ commanderAvailable: false, activeChain: null, activePipeline: null });
		expect(result).toContain("Optional scout");
		expect(result).toContain("subagent_create");
		expect(result).toContain('name: "scout"');
	});

	it("does not depend on a pre-spawned scout id", () => {
		const result = buildNormalPrompt({ commanderAvailable: false, activeChain: null, activePipeline: null });
		expect(result).not.toContain("subagent_continue");
		expect(result).not.toContain("SA1");
	});

	it("skips scouts for simple lookups and edits", () => {
		const result = buildNormalPrompt({ commanderAvailable: false, activeChain: null, activePipeline: null });
		expect(result.toLowerCase()).toContain("quick lookup");
		expect(result.toLowerCase()).toContain("simple edit");
	});

	it("mentions fallback if scout errors", () => {
		const result = buildNormalPrompt({ commanderAvailable: false, activeChain: null, activePipeline: null });
		expect(result.toLowerCase()).toContain("continue directly");
	});
});
