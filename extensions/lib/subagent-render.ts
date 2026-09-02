// ABOUTME: Pure render logic for subagent widget — title, summary, border count
// ABOUTME: Extracted from subagent-widget.ts for testability

export interface SubRenderState {
	id: number;
	status: "running" | "done" | "error";
	name: string;
	task: string;
	toolCount: number;
	elapsed: number;
	turnCount: number;
	summary?: string;
	model?: string;
	maxDurationMs?: number; // watchdog timeout for progress warning
	autoRemove?: boolean; // whether completed widgets are removed automatically
}

export interface SubRenderTheme {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

export interface SubRenderResult {
	lines: string[];
	borderCount: number;
}

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Truncate display text before styling so ANSI escape sequences cannot affect the limit. */
function truncateDisplay(text: string, width: number): string {
	const max = Math.max(1, Math.floor(width));
	const chars = Array.from(text);
	if (chars.length <= max) return text;
	if (max <= 1) return chars.slice(0, max).join("");
	return chars.slice(0, max - 1).join("") + "…";
}

/** Keep a widget detail on one terminal row; the full task remains in the journal. */
function singleLineDisplay(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Decide whether a completed widget should get the delayed auto-removal.
 * The pre-spawned scout keeps its state for /subcont, but its active-turn
 * widget must still disappear after completion.
 */
export function shouldScheduleWidgetRemoval(state: Pick<SubRenderState, "status" | "turnCount" | "autoRemove">, isPersistentScout: boolean): boolean {
	if (state.autoRemove !== false) return true;
	return isPersistentScout && state.status !== "running" && state.turnCount > 1;
}

/**
 * Build the title label: "NAME - SA{id}"
 */
export function subagentTitle(state: SubRenderState): string {
	return state.name.toUpperCase() + " - SA" + state.id;
}

/**
 * Render the content lines for a subagent widget.
 * Designed for display on a full-width colored background box.
 * Text uses bold white for title and light colors for details.
 * borderCount is always 1 (top divider only).
 */
export function renderSubagentWidget(
	state: SubRenderState,
	width: number,
	theme: SubRenderTheme,
): SubRenderResult {
	const lines: string[] = [];

	const title = subagentTitle(state);

	// Animated spinner for running state
	const spinner = state.status === "running"
		? BRAILLE_FRAMES[Math.floor(Date.now() / 80) % BRAILLE_FRAMES.length] + " "
		: state.status === "done" ? "✓ "
		: "✗ ";

	const turnLabel = state.turnCount > 1
		? ` · Turn ${state.turnCount}`
		: "";

	const modelSuffix = state.model ? ` | ${state.model}` : "";

	// Timeout warning label when approaching watchdog limit
	let timeoutLabel = "";
	if (state.status === "running" && state.maxDurationMs && state.maxDurationMs > 0) {
		const pct = state.elapsed / state.maxDurationMs;
		if (pct >= 0.95) {
			timeoutLabel = " | TIMING OUT";
		} else if (pct >= 0.80) {
			timeoutLabel = " | " + Math.round((state.maxDurationMs - state.elapsed) / 1000) + "s left";
		}
	}

	const statusColor = state.status === "running" ? "accent" : state.status === "done" ? "success" : "error";
	const prefix = truncateDisplay(spinner + title, width);
	const rawSuffix = `  ${Math.round(state.elapsed / 1000)}s · Tools: ${state.toolCount}${turnLabel}${modelSuffix}${timeoutLabel}`;
	const suffixWidth = Math.max(0, Math.floor(width) - Array.from(prefix).length);
	const suffix = truncateDisplay(rawSuffix, suffixWidth);
	const statusLine = theme.fg(statusColor, theme.bold(prefix)) + theme.fg("dim", suffix);

	// Line 1: status + compact stats + model (summary shown on line 2)
	lines.push(statusLine);

	// Line 2: summary (current activity) or task preview as fallback
	const detail = singleLineDisplay(state.summary || state.task);
	// Keep the historical 40-character preview contract, then apply the actual
	// terminal width so narrow panes do not wrap the widget.
	const compactDetail = detail.length > 40 ? detail.slice(0, 37) + "..." : detail;
	const detailPreview = truncateDisplay(`  └─ ${compactDetail}`, Math.max(1, width));
	lines.push(theme.fg("muted", detailPreview));

	return { lines, borderCount: 1 };
}

/**
 * Parse "/sub SCOUT review the deps" → { name: "SCOUT", task: "review the deps" }.
 * If the first word isn't ALL-CAPS, name defaults to "AGENT".
 */
export function parseSubName(input: string): { name: string; task: string } {
	const trimmed = input.trim();
	if (!trimmed) return { name: "AGENT", task: "" };

	const spaceIdx = trimmed.indexOf(" ");
	const firstWord = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
	const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

	if (/^[A-Z]{2,}$/.test(firstWord)) {
		return { name: firstWord, task: rest };
	}
	return { name: "AGENT", task: trimmed };
}
