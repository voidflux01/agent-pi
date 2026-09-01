// ABOUTME: Optional cross-process token/cost ledger for orchestration runs.
// ABOUTME: The ledger is inherited through PI_* environment variables and is
// updated from authoritative task-journal usage, so TEAM/CHAIN/PIPELINE share it.

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FILE_ENV = "PI_AGENT_PI_BUDGET_FILE";
const TOKENS_ENV = "PI_AGENT_PI_BUDGET_TOKENS";
const COST_ENV = "PI_AGENT_PI_BUDGET_COST_USD";
const ID_ENV = "PI_AGENT_PI_BUDGET_ID";

export interface OrchestrationBudget {
	file: string;
	maxTokens: number;
	maxCostUsd: number;
	id: string;
	totalTokens: number;
	costUsd: number;
}

interface BudgetEntry { sourceRunId: string; tokens: number; costUsd: number; recordedAt: number; }

const finitePositive = (value: unknown): number | undefined => {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

export function activeOrchestrationBudget(): OrchestrationBudget | undefined {
	const file = process.env[FILE_ENV];
	const maxTokens = finitePositive(process.env[TOKENS_ENV]);
	const maxCostUsd = finitePositive(process.env[COST_ENV]);
	if (!file || !maxTokens || !maxCostUsd) return undefined;
	const totals = readBudgetTotals(file);
	return { file, maxTokens, maxCostUsd, id: process.env[ID_ENV] ?? "", ...totals };
}

export function initOrchestrationBudget(directory: string, maxTokens: number, maxCostUsd: number): OrchestrationBudget {
	const safeTokens = Math.min(Math.max(1, Math.floor(maxTokens)), 100_000_000);
	const safeCost = Math.min(Math.max(0.01, maxCostUsd), 100_000);
	const file = join(directory, "orchestration-budget.jsonl");
	mkdirSync(dirname(file), { recursive: true });
	if (!existsSync(file)) writeFileSync(file, "", { mode: 0o600 });
	const budget = { file, maxTokens: safeTokens, maxCostUsd: safeCost, id: randomUUID(), totalTokens: 0, costUsd: 0 };
	process.env[FILE_ENV] = file;
	process.env[TOKENS_ENV] = String(safeTokens);
	process.env[COST_ENV] = String(safeCost);
	process.env[ID_ENV] = budget.id;
	return budget;
}

export function clearOrchestrationBudget(): void {
	delete process.env[FILE_ENV];
	delete process.env[TOKENS_ENV];
	delete process.env[COST_ENV];
	delete process.env[ID_ENV];
}

export function readBudgetTotals(file: string): { totalTokens: number; costUsd: number } {
	let totalTokens = 0;
	let costUsd = 0;
	try {
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as Partial<BudgetEntry>;
				if (typeof entry.tokens === "number" && Number.isFinite(entry.tokens)) totalTokens += Math.max(0, entry.tokens);
				if (typeof entry.costUsd === "number" && Number.isFinite(entry.costUsd)) costUsd += Math.max(0, entry.costUsd);
			} catch {}
		}
	} catch {}
	return { totalTokens, costUsd };
}

export function recordBudgetUsage(sourceRunId: string, usage: { totalTokens?: number; costUsd?: number }): boolean {
	const budget = activeOrchestrationBudget();
	if (!budget || !sourceRunId) return false;
	const tokens = Number(usage.totalTokens ?? 0);
	const costUsd = Number(usage.costUsd ?? 0);
	if (!Number.isFinite(tokens) || !Number.isFinite(costUsd) || tokens < 0 || costUsd < 0) return false;
	try {
		const existing = readFileSync(budget.file, "utf8").split("\n").some((line) => {
			try { return (JSON.parse(line) as Partial<BudgetEntry>).sourceRunId === sourceRunId; } catch { return false; }
		});
		if (existing) return false;
		const withinBudget = budget.totalTokens + tokens <= budget.maxTokens && budget.costUsd + costUsd <= budget.maxCostUsd;
		// Record actual usage even when it crosses the ceiling. Otherwise the
		// ledger understates spend and a later preflight could incorrectly pass.
		appendFileSync(budget.file, JSON.stringify({ sourceRunId, tokens, costUsd, recordedAt: Date.now() }) + "\n", "utf8");
		return withinBudget;
	} catch { return false; }
}

export function budgetStatus(): string | undefined {
	const budget = activeOrchestrationBudget();
	if (!budget) return undefined;
	return `${budget.totalTokens}/${budget.maxTokens} tokens · $${budget.costUsd.toFixed(4)}/$${budget.maxCostUsd.toFixed(4)}`;
}

export function budgetBlockReason(): string | undefined {
	const budget = activeOrchestrationBudget();
	if (!budget) return undefined;
	if (budget.totalTokens >= budget.maxTokens) return `shared token budget exhausted (${budget.totalTokens}/${budget.maxTokens})`;
	if (budget.costUsd >= budget.maxCostUsd) return `shared cost budget exhausted ($${budget.costUsd.toFixed(4)}/$${budget.maxCostUsd.toFixed(4)})`;
	return undefined;
}
