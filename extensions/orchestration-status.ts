// ABOUTME: Unified read-only orchestration status command and tool.
// ABOUTME: Aggregates compose, standard Pi, and toolkit runs by persisted runId.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { registerToolWithExecutor } from "./lib/tool-executor-registry.ts";
import { listOrchestrationRuns, listOrchestrationTopology, readOrchestrationEvents, summarizeOrchestrationModes, type OrchestrationTopology } from "./lib/orchestration-query.ts";
import { applyExtensionDefaults } from "./lib/themeMap.ts";

const Params = Type.Object({
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	run_id: Type.Optional(Type.String({ description: "Optional exact run id" })),
	mode: Type.Optional(Type.String({ description: "Optional coordination mode filter, e.g. NORMAL, PLAN, or SPEC" })),
	tree: Type.Optional(Type.Boolean({ description: "Render parent-child relationships" })),
	include_events: Type.Optional(Type.Boolean({ description: "For an exact run_id, include the last bounded event records" })),
});

function renderSummary(run: any): string {
	const duration = run.durationMs === undefined ? "running" : `${Math.round(run.durationMs / 1000)}s`;
	const parent = run.parentRunId ? ` parent=${run.parentRunId}` : "";
	const mode = run.mode ? ` mode=${run.mode}` : "";
	const tool = run.toolName ? ` tool=${run.toolName}${run.toolStatus === "blocked" && run.toolBlockCategory ? `:${run.toolBlockCategory}` : ""}` : "";
	const verification = run.verificationStatus ? ` verify=${run.verificationStatus}` : "";
	const files = Array.isArray(run.changedFiles) && run.changedFiles.length > 0 ? ` files=${run.changedFiles.length}` : "";
	const usage = run.totalTokens !== undefined || run.costUsd !== undefined ? ` usage=${Math.max(0, Math.floor(run.totalTokens ?? 0))}tok/$${Math.max(0, run.costUsd ?? 0).toFixed(4)}` : "";
	const recovery = run.recovery === "stale" ? ` recover=${run.recoveryAction === "subagent-resume" ? `subagent_resume:${run.recoveryDispatchId}` : run.recoveryAction || "inspect"}` : "";
	const failure = run.failureCause ? ` cause=${run.failureCause}` : "";
	return `${run.status.padEnd(9)} ${run.actor.padEnd(24)} ${duration.padStart(8)} ${run.eventCount} events${mode}${tool}${usage}${verification}${files}${failure}${recovery}  ${run.runId}${parent}`;
}

function renderEvent(event: any): string {
	let payload = "";
	if (event.payload !== undefined) {
		try {
			const encoded = JSON.stringify(event.payload);
			payload = encoded.length > 900 ? ` ${encoded.slice(0, 899)}…` : ` ${encoded}`;
		} catch { payload = " {\"serializationError\":true}"; }
	}
	return `${event.timestamp} ${event.actor} ${event.type}${payload}`;
}

function renderTree(topology: OrchestrationTopology, limit: number): string {
	const byId = new Map(topology.runs.map((run) => [run.runId, run]));
	const lines: string[] = [];
	const seen = new Set<string>();
	const visit = (id: string, depth: number) => {
		if (lines.length >= limit || seen.has(id)) return;
		seen.add(id);
		const run = byId.get(id);
		if (run) lines.push(`${"  ".repeat(depth)}${renderSummary(run)}`);
		for (const child of topology.childrenByParent[id] || []) visit(child, depth + 1);
	};
	for (const id of topology.rootRunIds) visit(id, 0);
	for (const id of topology.cycleRunIds) visit(id, 0);
	return lines.join("\n") || "No persisted orchestration runs found.";
}

function renderModeMetrics(runs: any[]): string {
	const metrics = summarizeOrchestrationModes(runs);
	const entries = Object.entries(metrics).sort(([a], [b]) => a.localeCompare(b)).map(([mode, value]) => {
		const average = value.runs > 0 ? Math.round(value.durationMs / value.runs / 1000) : 0;
		return `${mode} ${value.runs}runs/${value.succeeded}ok/${value.failed}fail/${value.stale}stale/${average}savg/${Math.floor(value.totalTokens)}tok/$${value.costUsd.toFixed(4)}`;
	});
	return entries.length ? `MODE METRICS: ${entries.join(" | ")}` : "";
}

export default function (pi: ExtensionAPI) {
	registerToolWithExecutor(pi, {
		name: "orchestration_status",
		label: "Orchestration Status",
		description: "List persisted orchestration runs from compose, Pi dispatch, and toolkit workers. Read-only; filter with limit or an exact run_id.",
		parameters: Params,
		capabilityRisk: "read",
		capabilityEffect: { ordering: "commutative" },
		async execute(_id, params, _signal, _update, ctx) {
			const cwd = ctx?.cwd || process.cwd();
			if (params.run_id) {
				const runs = listOrchestrationRuns(cwd, { limit: params.limit, runId: params.run_id, mode: params.mode });
				const events = params.include_events && runs[0] ? readOrchestrationEvents(runs[0].eventDir) : undefined;
				const timeline = events?.map(renderEvent).join("\n");
				const text = runs.length ? `${runs.map(renderSummary).join("\n")}${timeline ? `\n${timeline}` : ""}` : "No persisted orchestration runs found.";
				return { content: [{ type: "text" as const, text }], details: { count: runs.length, runs, modeMetrics: summarizeOrchestrationModes(runs), ...(events ? { events } : {}) } };
			}
			const topology = listOrchestrationTopology(cwd, { mode: params.mode });
			const limit = Math.max(1, Math.min(params.limit ?? 25, 100));
			const text = params.tree ? renderTree(topology, limit) : topology.runs.slice(0, limit).map(renderSummary).join("\n") || "No persisted orchestration runs found.";
			const metrics = summarizeOrchestrationModes(topology.runs);
			return { content: [{ type: "text" as const, text: `${text}${text === "No persisted orchestration runs found." ? "" : `\n${renderModeMetrics(topology.runs)}`}` }], details: { count: Math.min(topology.runs.length, limit), runs: topology.runs.slice(0, limit), topology, modeMetrics: metrics } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("orchestration_status ")) + theme.fg("accent", args.run_id || `${args.mode || "all"} ${args.limit || 25}`), 0, 0); },
		renderResult(result, _opts, theme) { return new Text(theme.fg("muted", `${result.details?.count ?? 0} orchestration run(s)`), 0, 0); },
	});

	pi.registerCommand("orchestration-status", {
		description: "Show persisted orchestration runs; pass a run id for exact inspection or 'events <run_id>' for its bounded timeline",
		handler: async (args, ctx) => {
			const input = (args ?? "").trim();
			const parts = input.split(/\s+/).filter(Boolean);
			const modeMatch = input.match(/^mode\s+(NORMAL|PLAN|SPEC|TEAM|CHAIN|PIPELINE)(?:\s+(tree))?$/i);
			if (modeMatch) {
				const mode = modeMatch[1].toUpperCase();
				const topology = listOrchestrationTopology(ctx.cwd || process.cwd(), { mode });
				const text = modeMatch[2] ? renderTree(topology, 25) : topology.runs.map(renderSummary).join("\n") || `No persisted ${mode} orchestration runs found.`;
				ctx.ui.notify(text, "info");
				return;
			}
			const exactId = parts[0] === "events" ? parts[1] : parts[0];
			if (exactId && /^[A-Za-z0-9_-]{1,128}$/.test(exactId) && parts[0] !== "tree" && !/^\d+$/.test(exactId)) {
				const runs = listOrchestrationRuns(ctx.cwd || process.cwd(), { runId: exactId, limit: 1 });
				if (runs.length === 0) { ctx.ui.notify("No persisted orchestration run found for that id.", "warning"); return; }
				if (parts[0] === "events") {
					ctx.ui.notify([renderSummary(runs[0]), ...readOrchestrationEvents(runs[0].eventDir).map(renderEvent)].join("\n"), "info");
					return;
				}
				ctx.ui.notify(renderSummary(runs[0]), "info");
				return;
			}
			const limit = input && /^\d+$/.test(input) ? Number(input) : 25;
			const topology = listOrchestrationTopology(ctx.cwd || process.cwd());
			const text = input.toLowerCase() === "tree"
				? renderTree(topology, limit)
				: topology.runs.slice(0, limit).map(renderSummary).join("\n") || "No persisted orchestration runs found.";
			ctx.ui.notify(text, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => applyExtensionDefaults(import.meta.url, ctx));
}
