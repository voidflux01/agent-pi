// ABOUTME: Tests for subagent widget rendering — title format, summary, and border count
// ABOUTME: Validates ROLE - SA{id} titles, pre-written summaries, and single top divider

import { describe, it, expect } from "vitest";
import { Box, Text } from "@mariozechner/pi-tui";
import { renderSubagentWidget, subagentTitle, parseSubName, shouldScheduleWidgetRemoval, type SubRenderState } from "../lib/subagent-render.ts";

function makeFakeTheme() {
	return {
		fg: (color: string, text: string) => `[${color}]${text}`,
		bold: (text: string) => `<b>${text}</b>`,
		inverse: (text: string) => `{{${text}}}`,
	};
}

function makeState(overrides: Partial<SubRenderState> = {}): SubRenderState {
	return {
		id: 1,
		status: "done",
		name: "AGENT",
		task: "do something",
		toolCount: 3,
		elapsed: 5000,
		turnCount: 1,
		...overrides,
	};
}

function visible(text: string): string {
	return text.replace(/\[[^\]]+\]|<\/?b>/g, "");
}

describe("widget cleanup policy", () => {
	it("removes the active persistent scout widget but keeps scout state", () => {
		expect(shouldScheduleWidgetRemoval({ autoRemove: false, status: "done", turnCount: 2 }, true)).toBe(true);
	});

	it("does not auto-remove the scout warmup state", () => {
		expect(shouldScheduleWidgetRemoval({ autoRemove: false, status: "done", turnCount: 1 }, true)).toBe(false);
	});

	it("removes an active persistent scout widget after an error too", () => {
		expect(shouldScheduleWidgetRemoval({ autoRemove: false, status: "error", turnCount: 2 }, true)).toBe(true);
	});

	it("preserves explicit autoRemove false for ordinary agents", () => {
		expect(shouldScheduleWidgetRemoval({ autoRemove: false, status: "done", turnCount: 2 }, false)).toBe(false);
	});
});

describe("renderSubagentWidget", () => {
	const theme = makeFakeTheme();

	it("renders title as ROLE - SA{id}", () => {
		const state = makeState({ name: "REVIEWER" });
		const result = renderSubagentWidget(state, 80, theme);

		expect(result.lines[0]).toContain("REVIEWER - SA1");
	});

	it("uses uppercased name in title", () => {
		const state = makeState({ name: "scout" });
		const result = renderSubagentWidget(state, 80, theme);

		expect(result.lines[0]).toContain("SCOUT - SA1");
	});

	it("shows status icon in title (✓ for done, ✗ for error)", () => {
		const done = makeState({ status: "done" });
		const doneResult = renderSubagentWidget(done, 80, theme);
		expect(doneResult.lines[0]).toContain("✓");

		const error = makeState({ status: "error" });
		const errorResult = renderSubagentWidget(error, 80, theme);
		expect(errorResult.lines[0]).toContain("✗");
	});

	it("shows summary on line 2 instead of task when present", () => {
		const state = makeState({ summary: "Code quality check passed" });
		const result = renderSubagentWidget(state, 80, theme);

		// Summary replaces task on line 2; title line has no summary
		expect(result.lines[0]).not.toContain("Code quality check passed");
		expect(result.lines[1]).toContain("Code quality check passed");
	});

	it("falls back to task preview on line 2 when no summary", () => {
		const state = makeState({ summary: undefined });
		const result = renderSubagentWidget(state, 80, theme);

		// Title line + detail line = 2 lines always
		expect(result.lines).toHaveLength(2);
		expect(result.lines[1]).toContain("do something");
	});

	it("reports exactly one border (top divider only)", () => {
		const state = makeState({ summary: "check this" });
		const result = renderSubagentWidget(state, 80, theme);

		expect(result.borderCount).toBe(1);
	});

	it("shows turn label when turnCount > 1", () => {
		const state = makeState({ turnCount: 3 });
		const result = renderSubagentWidget(state, 80, theme);

		expect(result.lines[0]).toContain("Turn 3");
	});

	it("defaults name to AGENT when not specified", () => {
		const state = makeState({ name: "AGENT" });
		const result = renderSubagentWidget(state, 80, theme);

		expect(result.lines[0]).toContain("AGENT - SA1");
	});

	it("shows elapsed time and tool count", () => {
		const state = makeState({ elapsed: 12000, toolCount: 7 });
		const result = renderSubagentWidget(state, 80, theme);

		expect(result.lines[0]).toContain("12s");
		expect(result.lines[0]).toContain("Tools: 7");
	});

	it("shows model as last component when present", () => {
		const state = makeState({ model: "x-ai/grok-4.1-fast" });
		const result = renderSubagentWidget(state, 80, theme);

		expect(result.lines[0]).toContain("| x-ai/grok-4.1-fast");
	});

	it("omits model suffix when model is undefined", () => {
		const state = makeState({ model: undefined });
		const result = renderSubagentWidget(state, 80, theme);

		// Should end with Tools count, no trailing pipe
		const line = result.lines[0];
		const toolsIdx = line.indexOf("Tools:");
		const afterTools = line.slice(toolsIdx);
		expect(afterTools).not.toContain("|");
	});

	it("keeps both rendered lines within a narrow terminal width", () => {
		const state = makeState({
			name: "VERY-LONG-REVIEWER",
			task: "a very long task description that must not wrap the widget",
			model: "provider/very-long-model-name",
		});
		const result = renderSubagentWidget(state, 32, theme);

		expect(visible(result.lines[0]).length).toBeLessThanOrEqual(32);
		expect(visible(result.lines[1]).length).toBeLessThanOrEqual(32);
		expect(result.lines[1]).toContain("…");
	});

	it("keeps multiline task summaries on one widget row", () => {
		const result = renderSubagentWidget(makeState({ task: "inspect files\nthen run tests\nreport only the result" }), 80, theme);

		expect(result.lines[1]).not.toContain("\n");
		expect(result.lines[1]).toContain("inspect files then run tests");
	});

	it("does not re-wrap lines after the widget Box applies its padding", () => {
		const outerWidth = 32;
		const result = renderSubagentWidget(makeState({
			name: "VERY-LONG-REVIEWER",
			model: "provider/very-long-model-name",
		}), outerWidth - 2, { fg: (_color: string, text: string) => text, bold: (text: string) => text });
		const box = new Box(1, 1, (line: string) => line);
		box.addChild(new Text(result.lines.join("\n"), 0, 0));

		const lines = box.render(outerWidth);
		expect(lines).toHaveLength(4); // top padding, two content rows, bottom padding
		expect(lines.every((line) => visible(line).length <= outerWidth)).toBe(true);
	});
});

describe("subagentTitle", () => {
	it("formats as NAME - SA{id}", () => {
		expect(subagentTitle({ id: 3, name: "scout" } as SubRenderState)).toBe("SCOUT - SA3");
	});
});

describe("parseSubName", () => {
	it("extracts ALL-CAPS first word as name", () => {
		expect(parseSubName("SCOUT review the deps")).toEqual({ name: "SCOUT", task: "review the deps" });
	});

	it("defaults to AGENT when first word is not all-caps", () => {
		expect(parseSubName("review the deps")).toEqual({ name: "AGENT", task: "review the deps" });
	});

	it("handles mixed-case first word as task", () => {
		expect(parseSubName("Scout review")).toEqual({ name: "AGENT", task: "Scout review" });
	});

	it("handles single ALL-CAPS word as name with empty task", () => {
		expect(parseSubName("SCOUT")).toEqual({ name: "SCOUT", task: "" });
	});

	it("handles empty string", () => {
		expect(parseSubName("")).toEqual({ name: "AGENT", task: "" });
	});
});
