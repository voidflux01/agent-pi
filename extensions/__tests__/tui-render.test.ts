// ABOUTME: Tests for shared TUI render lib (lib/tui)
// ABOUTME: Byte-identical expectations copied from extension call sites

import { describe, expect, it } from "bun:test";
import { toolCallText, toolResultText } from "../lib/tui/tool-render.ts";
import { truncatePreview } from "../lib/tui/text.ts";
import { safeUi, safeNotify, safeSetStatus, safeSetWidget, hideWidget } from "../lib/tui/widget.ts";
import { beginPanel, endPanel, sectionHeader, formatRow, KEY_HINT_FOOTER } from "../lib/tui/panel.ts";
import { statusLine } from "../lib/tui/status-line.ts";
import { Container } from "@mariozechner/pi-tui";
import type { AgentToolResult } from "@mariozechner/pi-coding-agent";

// Identity theme so output equals raw markup
const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => `**${text}**`,
};

describe("toolCallText", () => {
	it("truncates preview at 60 to 57 chars + ...", () => {
		const summary = "x".repeat(61);
		const out = toolCallText(theme, "advance_phase ", summary);
		expect(out).toBe(
			`<toolTitle>**advance_phase **</toolTitle><muted>${"x".repeat(57)}...</muted>`,
		);
	});

	it("keeps preview at exactly max length", () => {
		const summary = "y".repeat(60);
		const out = toolCallText(theme, "advance_phase ", summary);
		expect(out).toBe(`<toolTitle>**advance_phase **</toolTitle><muted>${"y".repeat(60)}</muted>`);
	});

	it("mode-cycler variant: accent prefix + dim separator + max 50", () => {
		const reason = "r".repeat(51);
		const out = toolCallText(theme, "set_mode ", reason, {
			accentPrefix: "PLAN",
			dimSeparator: " — ",
			maxPreview: 50,
		});
		expect(out).toBe(
			`<toolTitle>**set_mode **</toolTitle><accent>PLAN</accent><dim> — </dim><muted>${"r".repeat(47)}...</muted>`,
		);
	});

	it("mode-cycler variant omits preview segment when empty", () => {
		const out = toolCallText(theme, "set_mode ", "", { accentPrefix: "PLAN", dimSeparator: " — " });
		expect(out).toBe(`<toolTitle>**set_mode **</toolTitle><accent>PLAN</accent>`);
	});
});

describe("toolResultText", () => {
	it("renders text content", () => {
		const result = { content: [{ type: "text", text: "hello" }] } as unknown as AgentToolResult<unknown>;
		const t = toolResultText(result, theme);
		expect(t.render(80)[0]?.trimEnd()).toBe("hello");
	});

	it("renders empty string for non-text content", () => {
		const result = { content: [{ type: "image" }] } as unknown as AgentToolResult<unknown>;
		expect(toolResultText(result, theme).render(80)).toEqual([]);
	});

	it("renders empty string for missing content", () => {
		const result = { content: [] } as unknown as AgentToolResult<unknown>;
		expect(toolResultText(result, theme).render(80)).toEqual([]);
	});
});

describe("panel", () => {
	it("formatRow pads label and colors value", () => {
		const t = formatRow(theme, "STATUS", "done", "success", 14);
		expect(t.render(80)[0]?.trimEnd()).toBe(` <accent>**STATUS:       **</accent> <success>done</success>`);
	});

	it("sectionHeader fills innerWidth with dashes", () => {
		const t = sectionHeader(theme, "METADATA", 30);
		const line = t.render(80)[0]?.trimEnd() ?? "";
		expect(line.startsWith(" <accent>** ─── METADATA ")).toBe(true);
		expect(line.endsWith("**</accent>")).toBe(true);
		expect((line.match(/─/g) ?? []).length).toBe(19); // 16 filler + 3 label dashes; / 30 - visibleWidth(" ─── METADATA ")
	});

	it("endPanel appends spacer, footer, and bottom border", () => {
		const c = new Container();
		endPanel(c, theme, KEY_HINT_FOOTER);
		const lines = c.render(60);
		expect(lines.some((l) => l.trimEnd() === ` <dim>${KEY_HINT_FOOTER}</dim>`)).toBe(true);
	});

	it("KEY_HINT_FOOTER is the exact shared string", () => {
		expect(KEY_HINT_FOOTER).toBe(" ↑/↓ Navigate • Enter Expand • Esc Close");
	});

	it("beginPanel returns the same container", () => {
		const c = new Container();
		expect(beginPanel(theme, c)).toBe(c);
	});
});

describe("statusLine", () => {
	it("unselected with elapsed rounds seconds", () => {
		const out = statusLine(theme, "done", "Scout #1", 12500);
		expect(out).toBe(` <success>**✓ Scout #1**</success> 13s`);
	});

	it("no elapsed suffix when elapsed is 0", () => {
		const out = statusLine(theme, "done", "Scout #1", 0);
		expect(out).toBe(` <success>**✓ Scout #1**</success>`);
	});

	it("selected wraps pill in accent brackets", () => {
		const out = statusLine(theme, "running", "Scout", 1000, { selected: true, showAnimation: false });
		expect(out).toBe(
			` <accent>[</accent><accent>**● Scout**</accent><accent>]</accent> 1s`,
		);
	});
});

describe("truncatePreview", () => {
	it("returns empty string unchanged", () => {
		expect(truncatePreview("", 10)).toBe("");
	});
	it("returns short strings unchanged", () => {
		expect(truncatePreview("abc", 10)).toBe("abc");
	});
	it("returns string of exactly max length unchanged", () => {
		expect(truncatePreview("a".repeat(10), 10)).toBe("a".repeat(10));
	});
	it("truncates longer strings with ellipsis", () => {
		expect(truncatePreview("a".repeat(11), 10)).toBe("a".repeat(7) + "...");
	});
	it("honors custom ellipsis", () => {
		expect(truncatePreview("abcdef", 5, "…")).toBe("abcd…");
	});
});

describe("widget harness", () => {
	it("safeUi returns false for missing ctx/ui", () => {
		expect(safeUi(undefined, () => {})).toBe(false);
		expect(safeUi({}, () => {})).toBe(false);
		expect(safeUi({ hasUI: false, ui: {} }, () => {})).toBe(false);
	});

	it("safeUi swallows stale-context errors and returns false", () => {
		const throwingUi = { setStatus: () => { throw new Error("ctx is stale"); } };
		expect(safeUi({ ui: throwingUi }, (ui) => ui.setStatus("k", "v"))).toBe(false);
	});

	it("safeSetWidget returns false for throwing ui", () => {
		const throwingUi = { setWidget: () => { throw new Error("boom"); } };
		expect(safeSetWidget({ ui: throwingUi }, "k", {})).toBe(false);
		expect(safeSetWidget(undefined, "k", {})).toBe(false);
	});

	it("safeSetWidget forwards options only when defined", () => {
		const calls: unknown[] = [];
		const ui = { setWidget: (...args: unknown[]) => calls.push(args) };
		safeSetWidget({ ui }, "k", {});
		safeSetWidget({ ui }, "k2", {}, { a: 1 });
		expect(calls).toEqual([["k", {}], ["k2", {}, { a: 1 }]]);
	});

	it("safeNotify/safeSetStatus delegate to ui and return silently without ui", () => {
		const calls: unknown[] = [];
		safeNotify({ ui: { notify: (...a: unknown[]) => calls.push(a) } }, "msg", "info");
		safeNotify(undefined, "msg");
		safeSetStatus({ ui: { setStatus: (...a: unknown[]) => calls.push(a) } }, "k", "v");
		safeSetStatus({}, "k", "v");
		expect(calls).toEqual([["msg", "info"], ["k", "v"]]);
	});

	it("hideWidget tolerates missing ctx/ui and throwing ui", () => {
		expect(() => hideWidget(undefined, "k")).not.toThrow();
		expect(() => hideWidget({}, "k")).not.toThrow();
		expect(() => hideWidget({ ui: { setWidget: () => { throw new Error("boom"); } } }, "k")).not.toThrow();
	});

	it("hideWidget passes undefined renderer", () => {
		const calls: unknown[] = [];
		hideWidget({ ui: { setWidget: (...a: unknown[]) => calls.push(a) } }, "agent-chain");
		expect(calls).toEqual([["agent-chain", undefined]]);
	});
});
