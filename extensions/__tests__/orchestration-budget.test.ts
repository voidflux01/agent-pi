import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeOrchestrationBudget, budgetBlockReason, clearOrchestrationBudget, initOrchestrationBudget, readBudgetTotals, recordBudgetUsage } from "../lib/orchestration-budget.ts";

afterEach(() => clearOrchestrationBudget());

describe("orchestration budget", () => {
	test("records usage once and enforces shared totals", () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-pi-budget-"));
		const budget = initOrchestrationBudget(dir, 1000, 1);
		expect(recordBudgetUsage("run-a", { totalTokens: 400, costUsd: 0.4 })).toBe(true);
		expect(recordBudgetUsage("run-a", { totalTokens: 400, costUsd: 0.4 })).toBe(false);
		expect(recordBudgetUsage("run-b", { totalTokens: 700, costUsd: 0.2 })).toBe(false);
		expect(readBudgetTotals(budget.file)).toEqual({ totalTokens: 1100, costUsd: 0.6000000000000001 });
		expect(activeOrchestrationBudget()?.id).toBe(budget.id);
	});

	test("tolerates malformed ledger lines", () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-pi-budget-"));
		const budget = initOrchestrationBudget(dir, 1000, 1);
		appendFileSync(budget.file, "not-json\n{" + "\"tokens\": 5, \"costUsd\": 0.1}\n");
		expect(readBudgetTotals(budget.file)).toEqual({ totalTokens: 5, costUsd: 0.1 });
		expect(readFileSync(budget.file, "utf8")).toContain("not-json");
	});

	test("reports a preflight block only after a limit is reached", () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-pi-budget-"));
		initOrchestrationBudget(dir, 100, 1);
		expect(budgetBlockReason()).toBeUndefined();
		expect(recordBudgetUsage("run-limit", { totalTokens: 100, costUsd: 0.5 })).toBe(true);
		expect(budgetBlockReason()).toContain("token budget exhausted");
	});
});
