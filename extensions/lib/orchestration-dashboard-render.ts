// ABOUTME: Pure terminal rendering for the orchestration Activity widget.
// ABOUTME: Keeps layout decisions testable without booting the Pi UI runtime.

import type { OrchestrationRunSummary } from "./orchestration-query.ts";

export interface DashboardBudget {
	status: string;
	blocked: boolean;
}

export interface DashboardTheme {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

export interface DashboardInput {
	runs: OrchestrationRunSummary[];
	budget?: DashboardBudget;
	limit: number;
}

const short = (value: string, max: number): string => value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}…`;

function age(iso?: string): string {
	if (!iso) return "--";
	const ms = Date.now() - Date.parse(iso);
	if (!Number.isFinite(ms) || ms < 0) return "now";
	if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s`;
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
	return `${Math.floor(ms / 3_600_000)}h`;
}

export function renderOrchestrationDashboard(input: DashboardInput, width: number, theme: DashboardTheme): string[] {
	const usable = Math.max(32, width);
	const lines = [theme.fg("accent", theme.bold("ORCHESTRATION ACTIVITY"))];
	if (input.budget) {
		const marker = input.budget.blocked ? theme.fg("error", " BLOCKED") : "";
		lines.push(theme.fg("muted", `Budget ${input.budget.status}${marker}`));
	}
	if (input.runs.length === 0) {
		lines.push(theme.fg("muted", "No persisted runs · /orchestration-status for details"));
		return lines.map((line) => line.slice(0, usable));
	}
	lines.push(theme.fg("muted", `Recent ${Math.min(input.runs.length, input.limit)} · refresh 2s`));
	for (const run of input.runs.slice(0, input.limit)) {
		const status = run.status === "succeeded" ? "✓" : run.status === "failed" ? "✗" : run.status === "running" ? "●" : run.status === "stale" ? "!" : run.status === "cancelled" ? "–" : "?";
		const duration = run.durationMs === undefined ? age(run.startedAt) : `${Math.round(run.durationMs / 1000)}s`;
		const parent = run.parentRunId ? ` ←${short(run.parentRunId, 8)}` : "";
		const mode = run.mode ? ` ${short(run.mode, 8)}` : "";
		const verification = run.verificationStatus ? ` ${run.verificationStatus}` : "";
		const files = run.changedFiles?.length ? ` Δ${run.changedFiles.length}` : "";
		const line = `${status} ${short(run.actor, 18).padEnd(18)}${mode} ${duration.padStart(4)} ${run.eventCount}e${verification}${files} ${short(run.runId, 16)}${parent}`;
		lines.push(theme.fg(run.status === "failed" ? "error" : run.status === "succeeded" ? "success" : run.status === "stale" ? "warning" : "text", line).slice(0, usable));
	}
	return lines;
}
