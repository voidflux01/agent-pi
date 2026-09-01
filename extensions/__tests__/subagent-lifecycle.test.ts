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
		expect(src).toContain("elapsedTimer");
		expect(src).toContain("lifecycle.clearTimer(state.elapsedTimer)");
		expect(src).toContain("clearTimeout(state.watchdogTimer)");
		expect(src).toContain("lifecycle.clearProcess(proc)");
		expect(src).not.toContain("ctx?.cwd ?? process.cwd()");
	});

	it("installs the kill fallback before sending SIGTERM", () => {
		const src = readFileSync(join(__dirname, "..", "subagent-widget.ts"), "utf8");
		const killHelper = src.slice(src.indexOf("function killGracefully"), src.indexOf("function killGracefully") + 2_000);
		expect(killHelper.indexOf("const timer = setTimeout")).toBeGreaterThan(-1);
		expect(killHelper.indexOf("const timer = setTimeout")).toBeLessThan(killHelper.indexOf('proc.kill("SIGTERM")'));
	});

	it("records session-change cancellations as canonical cancelled journal rows", () => {
		const widget = readFileSync(join(__dirname, "..", "subagent-widget.ts"), "utf8");
		const team = readFileSync(join(__dirname, "..", "agent-team.ts"), "utf8");
		expect(widget).toContain('runStatus: "cancelled"');
		expect(widget).toContain('note: "cancelled: parent session changed"');
		expect(team).toContain('runStatus: code === 130 ? "cancelled" : undefined');
		expect(team).toContain("function clearAgentTimer");
		expect(team).toContain("clearAgentTimer(state)");
		expect(team).toContain("removeAllAgentWidgets(widgetCtx);\n\t\tfor (const state of agentStates.values()) {\n\t\t\tclearAgentTimer(state);");
	});

	it("awaits scout subagent_create until RESULT and skips the follow-up turn", () => {
		const src = readFileSync(join(__dirname, "..", "subagent-widget.ts"), "utf8");
		expect(src).toContain("shouldAwaitSubagentResult(agentName)");
		expect(src).toContain("if (!awaitResult)");
		expect(src).toContain("const result = await started");
		expect(src).toContain("if (!state.awaitResult)");
		expect(src).toContain('deliverAs: "steer"');
	});

	it("propagates synchronous tool cancellation into the worker abort boundary", () => {
		const widget = readFileSync(join(__dirname, "..", "subagent-widget.ts"), "utf8");
		expect(widget).toContain("signal: awaitResult ? signal : undefined");
		expect(widget).toContain("spawnEpoch !== sessionEpoch || !!options.signal?.aborted");
		expect(widget).toContain("signal?: AbortSignal");
	});

	it("attaches NORMAL/PLAN/SPEC subagent dispatches to an auditable parent run", () => {
		const src = readFileSync(join(__dirname, "..", "subagent-widget.ts"), "utf8");
		expect(src).toContain("createOrchestrationRun");
		expect(src).toContain('actor: `subagent:${state.name.toLowerCase()}`');
		expect(src).toContain('parentRunId: orchestrationRun.runId');
		expect(src).toContain('orchestrationRun.record("subagent.completed"');
		expect(src).toContain('orchestrationRun.finish(');
	});

	it("gives a parallel subagent batch one shared bounded parent run", () => {
		const src = readFileSync(join(__dirname, "..", "subagent-widget.ts"), "utf8");
		expect(src).toContain('actor: "subagent_batch"');
		expect(src).toContain("maxSteps: states.length");
		expect(src).toContain("batchRemaining");
		expect(src).toContain("orchestrationRun: batchRun");
		expect(src).toContain("onSettled: onBatchSettled");
	});

	it("exposes read-only persisted batch recovery without automatic replay", () => {
		const src = readFileSync(join(__dirname, "..", "subagent-widget.ts"), "utf8");
		expect(src).toContain('name: "subagent_batch_recover"');
		expect(src).toContain("inspectPersistedBatch(contextCwd(ctx), args.run_id)");
		expect(src).toContain("never re-dispatches workers automatically");
		expect(src).toContain("subagent_resume with an explicit prompt");
	});
});

describe("timeout resolution", () => {
	it("uses the shared safety deadline by default", () => {
		expect(resolveTimeout("SCOUT")).toBe(15 * 60_000);
		expect(resolveTimeout("BUILDER")).toBe(15 * 60_000);
	});

	it("honors an explicit timeout and explicit zero", () => {
		expect(resolveTimeout("SCOUT", 0)).toBe(0);
		expect(resolveTimeout("BUILDER", 30_000)).toBe(30_000);
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
	it("requires a scout for non-trivial PLAN reconnaissance but allows known small tasks to skip it", async () => {
		const { PLAN_PROMPT } = await import("../lib/mode-prompts.ts");
		expect(PLAN_PROMPT).toContain("Do not spawn a scout just because PLAN is active");
		expect(PLAN_PROMPT).toContain("two or more files");
		expect(PLAN_PROMPT).toContain("dispatch the scout before writing the plan");
		expect(PLAN_PROMPT).not.toContain("do not spawn scouts");
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
