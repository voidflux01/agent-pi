// ABOUTME: Tests for subagent lifecycle management — timeout, cleanup, batch guard, render warnings
// ABOUTME: Validates watchdog timeout resolution, stale cleanup, and duplicate batch prevention

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderSubagentWidget, type SubRenderState } from "../lib/subagent-render.ts";
import { resolveTimeout } from "../subagent-widget.ts";

// ── Timeout resolution tests ─────────────────────────────────────────────────
// We can't import resolveTimeout directly (it's a module-scoped function inside
// the extension default export), so we test the behavior via the render output
// and validate the constants match our expectations.

describe("stale session lifecycle protection", () => {
	it("does not auto-start a scout or child on session lifecycle events", () => {
		const src = readFileSync(join(__dirname, "..", "subagent-widget.ts"), "utf8");
		expect(src).not.toContain("preSpawnScout");
		expect(src).not.toContain("Warming up — standing by");
		expect(src).not.toContain("standby");
		expect(src).not.toContain("__piScout");
		expect(src).toContain("withSessionLifecycle");
	});

	it("snapshots cwd and invalidates late background callbacks", () => {
		const src = readFileSync(join(__dirname, "..", "subagent-widget.ts"), "utf8");
		expect(src).toContain('pi.on("session_shutdown"');
		expect(src).toContain("const spawnCwd = contextCwd(ctx);");
		expect(src).toContain("const spawnEpoch = sessionEpoch;");
		expect(src).toContain("if (spawnEpoch !== sessionEpoch)");
		expect(src).not.toContain("ctx?.cwd ?? process.cwd()");
	});

	it("awaits scout subagent_create until RESULT and skips the follow-up turn", () => {
		const src = readFileSync(join(__dirname, "..", "subagent-widget.ts"), "utf8");
		expect(src).toContain("shouldAwaitSubagentResult(agentName)");
		expect(src).toContain("if (!awaitResult)");
		expect(src).toContain("const result = await started");
		expect(src).toContain("if (!state.awaitResult)");
		expect(src).toContain('deliverAs: "followUp"');
	});
});

describe("timeout resolution", () => {
	it("uses a five-minute default for SCOUT", () => {
		expect(resolveTimeout("SCOUT")).toBe(5 * 60 * 1000);
	});

	it("honors an explicit zero timeout", () => {
		expect(resolveTimeout("SCOUT", 0)).toBe(0);
	});
});

describe("timeout render warnings", () => {
	function makeFakeTheme() {
		return {
			fg: (color: string, text: string) => `[${color}]${text}`,
			bold: (text: string) => `<b>${text}</b>`,
		};
	}

	function makeState(overrides: Partial<SubRenderState> = {}): SubRenderState {
		return {
			id: 1,
			status: "running",
			name: "SCOUT",
			task: "investigate codebase",
			toolCount: 5,
			elapsed: 0,
			turnCount: 1,
			maxDurationMs: 600_000, // 10 min
			...overrides,
		};
	}

	const theme = makeFakeTheme();

	it("shows no timeout warning when elapsed is below 80% of maxDuration", () => {
		const state = makeState({ elapsed: 400_000 }); // 6.7 min = 67%
		const result = renderSubagentWidget(state, 120, theme);
		expect(result.lines[0]).not.toContain("TIMING OUT");
		expect(result.lines[0]).not.toContain("left");
	});

	it("shows 'seconds left' warning when elapsed is between 80-95% of maxDuration", () => {
		const state = makeState({ elapsed: 510_000 }); // 8.5 min = 85%
		const result = renderSubagentWidget(state, 120, theme);
		expect(result.lines[0]).toContain("left");
		expect(result.lines[0]).toContain("90s left"); // 600-510 = 90s
	});

	it("shows TIMING OUT when elapsed is >= 95% of maxDuration", () => {
		const state = makeState({ elapsed: 580_000 }); // 9.67 min = 96.7%
		const result = renderSubagentWidget(state, 120, theme);
		expect(result.lines[0]).toContain("TIMING OUT");
	});

	it("shows no timeout warning when maxDurationMs is 0 (disabled)", () => {
		const state = makeState({ elapsed: 999_000, maxDurationMs: 0 });
		const result = renderSubagentWidget(state, 120, theme);
		expect(result.lines[0]).not.toContain("TIMING OUT");
		expect(result.lines[0]).not.toContain("left");
	});

	it("shows no timeout warning when maxDurationMs is undefined", () => {
		const state = makeState({ elapsed: 999_000, maxDurationMs: undefined });
		const result = renderSubagentWidget(state, 120, theme);
		expect(result.lines[0]).not.toContain("TIMING OUT");
		expect(result.lines[0]).not.toContain("left");
	});

	it("shows no timeout warning for done agents even with elapsed > maxDuration", () => {
		const state = makeState({ status: "done", elapsed: 700_000 });
		const result = renderSubagentWidget(state, 120, theme);
		expect(result.lines[0]).not.toContain("TIMING OUT");
		expect(result.lines[0]).not.toContain("left");
	});

	it("shows no timeout warning for error agents", () => {
		const state = makeState({ status: "error", elapsed: 700_000 });
		const result = renderSubagentWidget(state, 120, theme);
		expect(result.lines[0]).not.toContain("TIMING OUT");
		expect(result.lines[0]).not.toContain("left");
	});

	it("correctly calculates remaining seconds at 80% threshold boundary", () => {
		const state = makeState({ elapsed: 480_000 }); // exactly 80%
		const result = renderSubagentWidget(state, 120, theme);
		expect(result.lines[0]).toContain("120s left"); // 600-480 = 120s
	});

	it("correctly calculates remaining seconds at 95% threshold boundary", () => {
		const state = makeState({ elapsed: 570_000 }); // exactly 95%
		const result = renderSubagentWidget(state, 120, theme);
		expect(result.lines[0]).toContain("TIMING OUT");
	});
});

describe("PLAN prompt complexity guidance", () => {
	it("skips scouts for simple work", async () => {
		const { PLAN_PROMPT } = await import("../lib/mode-prompts.ts");
		expect(PLAN_PROMPT).toContain("do not spawn scouts");
	});

	it("uses the smallest sufficient scout count", async () => {
		const { PLAN_PROMPT } = await import("../lib/mode-prompts.ts");
		expect(PLAN_PROMPT).toContain("at most one");
		expect(PLAN_PROMPT).toContain("Never spawn four scouts by default");
	});

	it("does not prescribe the old batch lifecycle", async () => {
		const { PLAN_PROMPT } = await import("../lib/mode-prompts.ts");
		expect(PLAN_PROMPT).not.toContain("subagent_create_batch");
		expect(PLAN_PROMPT).not.toContain("Scout lifecycle management");
	});
});
