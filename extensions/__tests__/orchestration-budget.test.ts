import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeOrchestrationBudget, budgetBlockReason, clearOrchestrationBudget, initOrchestrationBudget, readBudgetTotals, recordBudgetUsage, releaseBudgetReservation, reserveBudget } from "../lib/orchestration-budget.ts";

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

	test("uses uncached tokens for admission while retaining full usage separately", () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-pi-budget-cache-"));
		initOrchestrationBudget(dir, 100, 1);
		expect(recordBudgetUsage("cached-run", { totalTokens: 1_000, budgetTokens: 40, costUsd: 0.1 })).toBe(true);
		expect(readBudgetTotals(activeOrchestrationBudget()!.file)).toEqual({ totalTokens: 40, costUsd: 0.1 });
		expect(budgetBlockReason()).toBeUndefined();
	});

	test("recovers a stale cross-process lock before recording usage", () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-pi-budget-"));
		const budget = initOrchestrationBudget(dir, 1000, 1);
		const lock = `${budget.file}.lock`;
		mkdirSync(lock);
		const old = new Date(Date.now() - 20_000);
		utimesSync(lock, old, old);
		expect(recordBudgetUsage("run-after-stale-lock", { totalTokens: 10, costUsd: 0.01 })).toBe(true);
		expect(readBudgetTotals(budget.file)).toEqual({ totalTokens: 10, costUsd: 0.01 });
	});

	test("reserves admission slices atomically and releases them on actual usage", () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-pi-budget-"));
		initOrchestrationBudget(dir, 1000, 1);
		const first = reserveBudget("run-reserved-a", 1000, 0.6);
		expect(first?.reservationId).toMatch(/^[A-Za-z0-9-]+$/);
		expect(reserveBudget("run-reserved-b", 500, 0.5)).toBeUndefined();
		expect(activeOrchestrationBudget()).toMatchObject({ reservedTokens: 1000, reservedCostUsd: 0.6 });
		expect(budgetBlockReason()).toContain("committed");
		expect(recordBudgetUsage("run-reserved-a", { totalTokens: 100, costUsd: 0.1 })).toBe(true);
		expect(activeOrchestrationBudget()).toMatchObject({ totalTokens: 100, reservedTokens: 0, reservedCostUsd: 0 });
	});

	test("can explicitly release an unused reservation", () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-pi-budget-"));
		initOrchestrationBudget(dir, 1000, 1);
		const reservation = reserveBudget("run-release", 100, 0.1);
		expect(reservation && releaseBudgetReservation(reservation)).toBe(true);
		expect(activeOrchestrationBudget()).toMatchObject({ reservedTokens: 0, reservedCostUsd: 0 });
	});

	test("does not count expired reservations as actual usage", () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-pi-budget-"));
		const budget = initOrchestrationBudget(dir, 1000, 1);
		appendFileSync(budget.file, JSON.stringify({ kind: "reservation", reservationId: "expired", sourceRunId: "dead-run", tokens: 900, costUsd: 0.9, expiresAt: Date.now() - 1, recordedAt: Date.now() }) + "\n");
		expect(readBudgetTotals(budget.file)).toEqual({ totalTokens: 0, costUsd: 0 });
		expect(activeOrchestrationBudget()).toMatchObject({ totalTokens: 0, reservedTokens: 0, reservedCostUsd: 0 });
	});
});
