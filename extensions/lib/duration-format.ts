// ABOUTME: Human-readable elapsed-time formatting for subagent completion lines.
// ABOUTME: < 60s renders as "Ns"; >= 60s renders as "Nm Ns" (e.g. "1m 12s").

/**
 * Format an elapsed duration in milliseconds for display.
 * - Less than 1 minute: "Ns" (e.g. "53s")
 * - At least 1 minute:  "Nm Ns" (e.g. "1m 12s", "10m 0s")
 *
 * Uses Math.round on the second count, matching the previous
 * `Math.round(ms / 1000)s` behavior at call sites. Negative input is
 * clamped to 0. No hour unit — minute counts past 60 render as "60m 0s".
 */
export function formatDuration(totalMs: number): string {
 const totalSecs = Math.max(0, Math.round(totalMs / 1000));
 if (totalSecs < 60) return `${totalSecs}s`;
 const min = Math.floor(totalSecs / 60);
 return `${min}m ${totalSecs % 60}s`;
}
