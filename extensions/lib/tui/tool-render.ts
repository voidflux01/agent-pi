// ABOUTME: Shared tool call/result render helpers
// ABOUTME: Extracted from pipeline-team.ts, mode-cycler.ts, and agent-team.ts

import { Text } from "@mariozechner/pi-tui";
import type { AgentToolResult } from "@mariozechner/pi-coding-agent";
import { asUiTheme } from "./theme.ts";
import { truncatePreview } from "./text.ts";

export interface ToolCallTextOptions {
	/** Color used for the truncated preview. Default "muted" (pipeline-team variant). */
	previewColor?: string;
	/** Max preview length before truncation. Default 60 (pipeline-team); mode-cycler uses 50. */
	maxPreview?: number;
	/**
	 * mode-cycler variant only: rendered in "accent" between the bold name and
	 * the dim separator (e.g. uppercased mode name).
	 */
	accentPrefix?: string;
	/**
	 * mode-cycler variant only: rendered in "dim" between the accent prefix and
	 * the preview (e.g. " — "). The preview segment is skipped entirely when
	 * the preview is empty.
	 */
	dimSeparator?: string;
}

/**
 * Build the tool-call line: bold toolTitle name + colored preview.
 *
 * pipeline-team.ts variant (advance_phase renderCall, lines 1112-1118):
 *   toolCallText(theme, "advance_phase ", summary)
 *   → toolTitle bold name + muted preview truncated at 60.
 *
 * mode-cycler.ts variant (set_mode renderCall, lines 197-213):
 *   toolCallText(theme, "set_mode ", reason, {
 *     accentPrefix: mode.toUpperCase(), dimSeparator: " — ", maxPreview: 50,
 *   })
 *   → toolTitle bold name + accent prefix + dim " — " + muted preview
 *     truncated at 50, preview segment omitted when reason is empty.
 */
export function toolCallText(
	theme: unknown,
	name: string,
	preview: string,
	opts?: ToolCallTextOptions,
): string {
	const t = asUiTheme(theme);
	const previewColor = opts?.previewColor ?? "muted";
	const maxPreview = opts?.maxPreview ?? 60;
	let text = t.fg("toolTitle", t.bold(name));
	if (opts?.accentPrefix !== undefined) {
		text += t.fg("accent", opts.accentPrefix);
		if (preview) {
			const truncated = truncatePreview(preview, maxPreview);
			text += (opts.dimSeparator ? t.fg("dim", opts.dimSeparator) : "") + t.fg(previewColor, truncated);
		}
		return text;
	}
	const truncated = truncatePreview(preview, maxPreview);
	return text + t.fg(previewColor, truncated);
}

/**
 * Build a Text from the first text block of a tool result (empty string when
 * the result has no text content). Byte-identical to the pattern at
 * agent-team.ts:995-999 (also pipeline-team.ts and mode-cycler.ts renderResult).
 */
export function toolResultText(result: AgentToolResult<unknown>, _theme: unknown): Text {
	const text = result.content[0];
	return new Text(text?.type === "text" ? text.text : "", 0, 0);
}
