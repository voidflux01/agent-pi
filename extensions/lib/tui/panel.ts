// ABOUTME: Shared detail-panel scaffold (borders, footers, section headers, rows)
// ABOUTME: Extracted from agent-team.ts:1283-1365 and agent-chain.ts:936-1005

import { Text, Container, Spacer, visibleWidth } from "@mariozechner/pi-tui";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { asUiTheme } from "./theme.ts";
import { padRight } from "../ui-helpers.ts";

/** Footer key hints used by the detail panels. */
export const KEY_HINT_FOOTER = " ↑/↓ Navigate • Enter Expand • Esc Close";

/**
 * Begin a detail panel: adds the top accent DynamicBorder to the container.
 * Used at agent-team.ts:1291 and agent-chain.ts:946.
 */
export function beginPanel(theme: unknown, container: Container): Container {
	const t = asUiTheme(theme);
	container.addChild(new DynamicBorder((s: string) => t.fg("accent", s)));
	return container;
}

/**
 * End a detail panel: Spacer, optional dim key-hint footer, bottom accent
 * DynamicBorder. Used at pipeline-team.ts:952-955 and agent-team.ts footer.
 */
export function endPanel(container: Container, theme: unknown, footer?: string): Container {
	const t = asUiTheme(theme);
	container.addChild(new Spacer(1));
	if (footer) {
		container.addChild(new Text(t.fg("dim", footer), 1, 0));
	}
	container.addChild(new DynamicBorder((s: string) => t.fg("accent", s)));
	return container;
}

/**
 * Section header filling `innerWidth` with ─ characters:
 * ` ─── TITLE ─────...` in accent bold. Identical closure at
 * agent-team.ts:1305-1309 and agent-chain.ts:955-959.
 */
export function sectionHeader(theme: unknown, label: string, innerWidth: number): Text {
	const t = asUiTheme(theme);
	const text = ` ─── ${label} `;
	const remaining = Math.max(0, innerWidth - visibleWidth(text));
	return new Text(t.fg("accent", t.bold(text + "─".repeat(remaining))), 1, 0);
}

/**
 * Metadata row: accent bold padded label + space + colored value.
 * Identical closure at agent-team.ts:1310-1314 and agent-chain.ts:960-964.
 * Call sites pad to width 14.
 */
export function formatRow(theme: unknown, label: string, value: string, color: string, width: number): Text {
	const t = asUiTheme(theme);
	const labelStr = t.fg("accent", t.bold(padRight(label + ":", width)));
	const valueStr = t.fg(color, value);
	return new Text(labelStr + " " + valueStr, 1, 0);
}
