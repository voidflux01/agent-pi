// ABOUTME: Session command for opt-in cross-process orchestration budgets.
// ABOUTME: Child workers inherit the budget through the least-privilege PI_* environment.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { applyExtensionDefaults } from "./lib/themeMap.ts";
import { budgetStatus, clearOrchestrationBudget, initOrchestrationBudget } from "./lib/orchestration-budget.ts";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("budget", {
		description: "Set or inspect the shared orchestration token/cost budget: /budget [tokens] [cost_usd]",
		handler: async (args, ctx) => {
			const input = (args ?? "").trim();
			if (!input || input === "status") {
				ctx.ui.notify(budgetStatus() ?? "No shared orchestration budget is active", "info");
				return;
			}
			if (input === "clear") {
				clearOrchestrationBudget();
				ctx.ui.notify("Shared orchestration budget cleared", "info");
				return;
			}
			const [tokensText, costText] = input.split(/\s+/);
			const tokens = Number(tokensText);
			const cost = Number(costText);
			if (!Number.isFinite(tokens) || !Number.isFinite(cost) || tokens <= 0 || cost <= 0) {
				ctx.ui.notify("Usage: /budget <max_tokens> <max_cost_usd>", "warning");
				return;
			}
			const budget = initOrchestrationBudget(`${ctx.cwd}/.pi/agent-sessions`, tokens, cost);
			ctx.ui.notify(`Shared orchestration budget active: ${budget.maxTokens} tokens · $${budget.maxCostUsd.toFixed(2)}`, "success");
		},
	});
	pi.on("session_start", async (_event, ctx) => applyExtensionDefaults(import.meta.url, ctx));
	pi.on("session_shutdown", async () => clearOrchestrationBudget());
}
