// ABOUTME: Pure terminal rendering for the orchestration Activity widget.
// ABOUTME: Keeps layout decisions testable without booting the Pi UI runtime.

import type { OrchestrationModeMetrics, OrchestrationRunSummary } from "./orchestration-query.ts";

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
	mode?: string;
	modeMetrics?: Record<string, OrchestrationModeMetrics>;
}

const short = (value: string, max: number): string => value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}…`;

// Theme implementations wrap rows in ANSI sequences. Count only printable
// characters when fitting a row so a narrow terminal cannot split a color code.
function fitStyled(value: string, width: number): string {
	if (!value.includes("\x1b")) return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
	let visible = 0;
	let end = value.length;
	for (let i = 0; i < value.length;) {
		if (value[i] === "\x1b") {
			const match = value.slice(i).match(/^\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/);
			if (match) { i += match[0].length; continue; }
		}
		if (visible === width) { end = i; break; }
		visible += 1;
		i += [...value.slice(i)][0]?.length || 1;
	}
	if (end === value.length) return value;
	const clipped = value.slice(0, end);
	return `${clipped}\x1b[0m`;
}

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
	const modeLabel = input.mode ? ` · ${input.mode.toUpperCase()}` : "";
	const lines = [theme.fg("accent", theme.bold(`ORCHESTRATION ACTIVITY${modeLabel}`))];
	if (input.budget) {
		const marker = input.budget.blocked ? theme.fg("error", " BLOCKED") : "";
		lines.push(theme.fg("muted", `Budget ${input.budget.status}${marker}`));
	}
	if (input.mode && input.modeMetrics?.[input.mode.toUpperCase()]) {
		const metrics = input.modeMetrics[input.mode.toUpperCase()];
		const average = metrics.runs > 0 ? Math.round(metrics.durationMs / metrics.runs / 1000) : 0;
		lines.push(theme.fg("muted", `Metrics ${metrics.runs}runs · ${metrics.succeeded}ok/${metrics.failed}fail/${metrics.stale}stale · ${average}savg · ${Math.floor(metrics.totalTokens).toLocaleString()}tok · $${metrics.costUsd.toFixed(4)}`));
	}
	if (input.runs.length === 0) {
		lines.push(theme.fg("muted", "No persisted runs · /orchestration-status for details"));
		return lines.map((line) => fitStyled(line, usable));
	}
	lines.push(theme.fg("muted", `Recent ${Math.min(input.runs.length, input.limit)} · refresh 2s`));
	for (const run of input.runs.slice(0, input.limit)) {
		const status = run.status === "succeeded" ? "✓" : run.status === "failed" ? "✗" : run.status === "running" ? "●" : run.status === "stale" ? "!" : run.status === "cancelled" ? "–" : "?";
		const duration = run.durationMs === undefined ? age(run.startedAt) : `${Math.round(run.durationMs / 1000)}s`;
		const parent = run.parentRunId ? ` ←${short(run.parentRunId, 8)}` : "";
		const mode = run.mode ? ` ${short(run.mode, 8)}` : "";
		const tool = run.toolName ? ` ${short(run.toolName, 16)}` : "";
		const verification = run.verificationStatus ? ` ${run.verificationStatus}` : "";
		const files = run.changedFiles?.length ? ` Δ${run.changedFiles.length}` : "";
		const usage = run.totalTokens !== undefined || run.costUsd !== undefined
			? ` ${Math.max(0, Math.floor(run.totalTokens ?? 0)).toLocaleString()}tok/$${Math.max(0, run.costUsd ?? 0).toFixed(4)}`
			: "";
		const recovery = run.status === "stale" ? ` ${run.recoveryAction === "subagent-resume" ? `resume:${short(run.recoveryDispatchId || "?", 12)}` : run.recoveryAction || "inspect"}` : "";
		const failure = run.failureCause ? ` ${short(run.failureCause, 12)}` : "";
		const fields = [
			`${status} ${short(run.actor, 18)}`,
			mode.trim(),
			tool.trim(),
			`${duration} · ${run.eventCount}e`,
			usage.trim(),
			verification.trim(),
			files.trim(),
			failure.trim(),
			recovery.trim(),
			short(run.runId, 16) + parent,
		].filter(Boolean);
		const line = fields.join(" · ");
		const color = run.status === "failed" ? "error" : run.status === "succeeded" ? "success" : run.status === "stale" ? "warning" : "text";
		lines.push(fitStyled(theme.fg(color, line), usable));
	}
	return lines;
}
