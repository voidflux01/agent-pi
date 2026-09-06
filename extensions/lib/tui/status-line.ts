// ABOUTME: Shared status pill line builder on top of pipeline-render statusButton
// ABOUTME: Extracted from pipeline-team.ts:938-940, agent-team.ts:1291-1294, agent-chain.ts:273-289

import { statusButton, type AgentStatus } from "../pipeline-render.ts";
import { asUiTheme } from "./theme.ts";

export interface StatusLineOptions {
	/** Wrap the pill in accent brackets: ` [pill] 12s` (agent-chain selected step). */
	selected?: boolean;
	/**
	 * Pass false to render the running state without the braille spinner
	 * (agent-team detail panel uses statusButton(..., false)).
	 */
	showAnimation?: boolean;
}

/**
 * Build ` statusButton(status, label) + " Ns"` with dim elapsed seconds.
 *
 * - pipeline-team.ts:938-940: `statusBtn + " " + dim(" Ns")` when elapsed > 0.
 * - agent-team.ts:1291-1294: `statusBtn + " Ns"` when status !== "idle".
 * - agent-chain.ts:273-289: selected steps wrapped in accent brackets; no
 *   time suffix for pending steps.
 *
 * Unified rule: the elapsed suffix is emitted when elapsedMs > 0 (callers
 * already guard by status before passing elapsedMs).
 */
export function statusLine(
	theme: unknown,
	status: AgentStatus,
	label: string,
	elapsedMs: number,
	opts?: StatusLineOptions,
): string {
	const t = asUiTheme(theme);
	const btn = statusButton(status, label, t, opts?.showAnimation ?? true);
	const timeStr = elapsedMs > 0 ? ` ${Math.round(elapsedMs / 1000)}s` : "";
	if (opts?.selected) {
		return ` ${t.fg("accent", "[")}${btn}${t.fg("accent", "]")}${timeStr}`;
	}
	return ` ${btn}${timeStr}`;
}
