// ABOUTME: Unified read-only orchestration status command and tool.
// ABOUTME: Aggregates compose, standard Pi, and toolkit runs by persisted runId.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { registerToolWithExecutor } from "./lib/tool-executor-registry.ts";
import { listOrchestrationRuns } from "./lib/orchestration-query.ts";
import { applyExtensionDefaults } from "./lib/themeMap.ts";

const Params = Type.Object({
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	run_id: Type.Optional(Type.String({ description: "Optional exact run id" })),
});

function renderSummary(run: any): string {
	const duration = run.durationMs === undefined ? "running" : `${Math.round(run.durationMs / 1000)}s`;
	const parent = run.parentRunId ? ` parent=${run.parentRunId}` : "";
	return `${run.status.padEnd(9)} ${run.actor.padEnd(24)} ${duration.padStart(8)} ${run.eventCount} events  ${run.runId}${parent}`;
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
			const runs = listOrchestrationRuns(ctx?.cwd || process.cwd(), { limit: params.limit, runId: params.run_id });
			const text = runs.length ? runs.map(renderSummary).join("\n") : "No persisted orchestration runs found.";
			return { content: [{ type: "text" as const, text }], details: { count: runs.length, runs } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("orchestration_status ")) + theme.fg("accent", args.run_id || `latest ${args.limit || 25}`), 0, 0); },
		renderResult(result, _opts, theme) { return new Text(theme.fg("muted", `${result.details?.count ?? 0} orchestration run(s)`), 0, 0); },
	});

	pi.registerCommand("orchestration-status", {
		description: "Show persisted compose and worker orchestration runs",
		handler: async (args, ctx) => {
			const input = (args ?? "").trim();
			const limit = input && /^\d+$/.test(input) ? Number(input) : 25;
			const runs = listOrchestrationRuns(ctx.cwd || process.cwd(), { limit });
			ctx.ui.notify(runs.length ? runs.map(renderSummary).join("\n") : "No persisted orchestration runs found.", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => applyExtensionDefaults(import.meta.url, ctx));
}
