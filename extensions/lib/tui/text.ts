// ABOUTME: Shared text truncation helper for TUI previews
// ABOUTME: Byte-identical to the slice(0, max - 3) + "..." pattern at all call sites

/**
 * Truncate `s` to at most `max` visible characters, appending `ellipsis`
 * (default "...") when truncation occurs.
 *
 * Call sites: pipeline-team.ts:195, agent-team.ts:1298-1301,
 * agent-chain.ts:283-295, mode-cycler.ts:202.
 */
export function truncatePreview(s: string, max: number, ellipsis: string = "..."): string {
	if (s.length > max) return s.slice(0, max - ellipsis.length) + ellipsis;
	return s;
}
