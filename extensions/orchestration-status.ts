// ABOUTME: Unified read-only orchestration status command and tool.
// ABOUTME: Aggregates compose, standard Pi, and toolkit runs by persisted runId.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { registerToolWithExecutor } from "./lib/tool-executor-registry.ts";
import { listOrchestrationRuns, listOrchestrationTopology, readOrchestrationEvents, type OrchestrationTopology } from "./lib/orchestration-query.ts";
import { applyExtensionDefaults } from "./lib/themeMap.ts";

const Params = Type.Object({
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	run_id: Type.Optional(Type.String({ description: "Optional exact run id" })),
	tree: Type.Optional(Type.Boolean({ description: "Render parent-child relationships" })),
	include_events: Type.Optional(Type.Boolean({ description: "For an exact run_id, include the last bounded event records" })),
});

function renderSummary(run: any): string {
	const duration = run.durationMs === undefined ? "running" : `${Math.round(run.durationMs / 1000)}s`;
	const parent = run.parentRunId ? ` parent=${run.parentRunId}` : "";
	const mode = run.mode ? ` mode=${run.mode}` : "";
	const verification = run.verificationStatus ? ` verify=${run.verificationStatus}` : "";
	const files = Array.isArray(run.changedFiles) && run.changedFiles.length > 0 ? ` files=${run.changedFiles.length}` : "";
	return `${run.status.padEnd(9)} ${run.actor.padEnd(24)} ${duration.padStart(8)} ${run.eventCount} events${mode}${verification}${files}  ${run.runId}${parent}`;
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
				const runs = listOrchestrationRuns(cwd, { limit: params.limit, runId: params.run_id });
				const events = params.include_events && runs[0] ? readOrchestrationEvents(runs[0].eventDir) : undefined;
				const timeline = events?.map(event => `${event.timestamp} ${event.actor} ${event.type}`).join("\n");
				const text = runs.length ? `${runs.map(renderSummary).join("\n")}${timeline ? `\n${timeline}` : ""}` : "No persisted orchestration runs found.";
				return { content: [{ type: "text" as const, text }], details: { count: runs.length, runs, ...(events ? { events } : {}) } };
			}
			const topology = listOrchestrationTopology(cwd);
			const limit = Math.max(1, Math.min(params.limit ?? 25, 100));
			const text = params.tree ? renderTree(topology, limit) : topology.runs.slice(0, limit).map(renderSummary).join("\n") || "No persisted orchestration runs found.";
			return { content: [{ type: "text" as const, text }], details: { count: Math.min(topology.runs.length, limit), runs: topology.runs.slice(0, limit), topology } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("orchestration_status ")) + theme.fg("accent", args.run_id || `latest ${args.limit || 25}`), 0, 0); },
		renderResult(result, _opts, theme) { return new Text(theme.fg("muted", `${result.details?.count ?? 0} orchestration run(s)`), 0, 0); },
	});

	pi.registerCommand("orchestration-status", {
		description: "Show persisted compose and worker orchestration runs",
		handler: async (args, ctx) => {
			const input = (args ?? "").trim();
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
