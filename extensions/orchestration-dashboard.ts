// ABOUTME: Live TUI Activity widget for persisted orchestration runs.
// ABOUTME: Reuses the orchestration query and budget ledgers; no new service is required.

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { applyExtensionDefaults } from "./lib/themeMap.ts";
import { listOrchestrationRuns, listOrchestrationTopology, summarizeOrchestrationModes } from "./lib/orchestration-query.ts";
import { activeOrchestrationBudget, budgetBlockReason, budgetStatus } from "./lib/orchestration-budget.ts";
import { renderOrchestrationDashboard } from "./lib/orchestration-dashboard-render.ts";

const KEY = "orchestration-dashboard";
const REFRESH_MS = 2_000;
let visible = false;
let timer: ReturnType<typeof setInterval> | undefined;
let currentCtx: ExtensionContext | undefined;
let widgetText: Text | undefined;
let dashboardMode: string | undefined;

function hasDashboardData(ctx: ExtensionContext): boolean {
	return Boolean(activeOrchestrationBudget() || listOrchestrationRuns(ctx.cwd || process.cwd(), { limit: 1, mode: dashboardMode }).length);
}

function hide(ctx: ExtensionContext): void {
	visible = false;
	if (timer) clearInterval(timer);
	timer = undefined;
	widgetText = undefined;
	try { ctx.ui.setWidget(KEY, undefined); } catch {}
}

function show(ctx: ExtensionContext): void {
	if (!ctx.hasUI || !ctx.ui) return;
	currentCtx = ctx;
	visible = true;
	try {
		ctx.ui.setWidget(KEY, (_tui: any, theme: any) => {
			widgetText = new Text("", 0, 0);
			return {
				render(width: number): string[] {
					const runs = listOrchestrationTopology(ctx.cwd || process.cwd(), { mode: dashboardMode }).runs;
					const modeMetrics = summarizeOrchestrationModes(runs);
					const budget = budgetStatus();
					const lines = renderOrchestrationDashboard({
						runs,
						limit: 8,
						...(dashboardMode ? { mode: dashboardMode } : {}),
						...(dashboardMode ? { modeMetrics } : {}),
						...(budget ? { budget: { status: budget, blocked: Boolean(budgetBlockReason()) } } : {}),
					}, width, theme);
					widgetText!.setText(lines.join("\n"));
					return widgetText!.render(width);
				},
				invalidate() { widgetText?.invalidate(); },
			};
		}, { placement: "aboveEditor" });
	} catch {}
	if (!timer) timer = setInterval(() => widgetText?.invalidate(), REFRESH_MS);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("orchestration-dashboard", {
		description: "Toggle the live orchestration Activity dashboard (on|off|mode <NORMAL|PLAN|SPEC|TEAM|CHAIN|PIPELINE>)",
		handler: async (args, ctx) => {
			const input = (args || "").trim();
			const modeMatch = input.match(/^mode\s+(NORMAL|PLAN|SPEC|TEAM|CHAIN|PIPELINE|all)$/i);
			if (modeMatch) dashboardMode = modeMatch[1].toUpperCase() === "ALL" ? undefined : modeMatch[1].toUpperCase();
			if (input.toLowerCase() === "off") hide(ctx);
			else if (input.toLowerCase() === "on" || modeMatch) show(ctx);
			else if (visible) hide(ctx);
			else show(ctx);
			ctx.ui.notify(`${visible ? "Orchestration dashboard: on" : "Orchestration dashboard: off"}${dashboardMode ? ` · ${dashboardMode}` : ""}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		currentCtx = ctx;
		if (hasDashboardData(ctx)) show(ctx);
	});
	pi.on("session_switch", async (_event, ctx) => {
		if (currentCtx) hide(currentCtx);
		currentCtx = ctx;
		if (hasDashboardData(ctx)) show(ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => hide(ctx));
}
