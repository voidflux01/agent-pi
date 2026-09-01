// ABOUTME: Optional cross-process token/cost ledger for orchestration runs.
// ABOUTME: The ledger is inherited through PI_* environment variables and is
// updated from authoritative task-journal usage, so TEAM/CHAIN/PIPELINE share it.

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
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
	reservedTokens: number;
	reservedCostUsd: number;
}

export interface BudgetReservation {
	reservationId: string;
	sourceRunId: string;
	tokens: number;
	costUsd: number;
	expiresAt: number;
}

interface BudgetEntry {
	kind?: "usage" | "reservation" | "reservation_released";
	sourceRunId: string;
	tokens: number;
	costUsd: number;
	recordedAt: number;
	reservationId?: string;
	expiresAt?: number;
}

const LOCK_WAIT_MS = 5;
const LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_MS = 10_000;
const DEFAULT_RESERVATION_SLOTS = 16;

/** Serialize read/check/append across independent worker processes. */
function withBudgetLock<T>(file: string, action: () => T): T | undefined {
	const lock = `${file}.lock`;
	const started = Date.now();
	while (true) {
		try {
			mkdirSync(lock, { recursive: false, mode: 0o700 });
			break;
		} catch {
			try {
				if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { recursive: true, force: true });
			} catch {}
			if (Date.now() - started >= LOCK_TIMEOUT_MS) return undefined;
			try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS); } catch {}
		}
	}
	try { return action(); } finally { try { rmSync(lock, { recursive: true, force: true }); } catch {} }
}

const finitePositive = (value: unknown): number | undefined => {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

export function activeOrchestrationBudget(): OrchestrationBudget | undefined {
	const file = process.env[FILE_ENV];
	const maxTokens = finitePositive(process.env[TOKENS_ENV]);
	const maxCostUsd = finitePositive(process.env[COST_ENV]);
	if (!file || !maxTokens || !maxCostUsd) return undefined;
	const totals = readBudgetState(file);
	return { file, maxTokens, maxCostUsd, id: process.env[ID_ENV] ?? "", ...totals };
}

export function initOrchestrationBudget(directory: string, maxTokens: number, maxCostUsd: number): OrchestrationBudget {
	const safeTokens = Math.min(Math.max(1, Math.floor(maxTokens)), 100_000_000);
	const safeCost = Math.min(Math.max(0.01, maxCostUsd), 100_000);
	const file = join(directory, "orchestration-budget.jsonl");
	mkdirSync(dirname(file), { recursive: true });
	if (!existsSync(file)) writeFileSync(file, "", { mode: 0o600 });
	const budget = { file, maxTokens: safeTokens, maxCostUsd: safeCost, id: randomUUID(), totalTokens: 0, costUsd: 0, reservedTokens: 0, reservedCostUsd: 0 };
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
	const state = readBudgetState(file);
	return { totalTokens: state.totalTokens, costUsd: state.costUsd };
}

function readBudgetState(file: string, now = Date.now()): { totalTokens: number; costUsd: number; reservedTokens: number; reservedCostUsd: number; reservations: Map<string, BudgetReservation> } {
	let totalTokens = 0;
	let costUsd = 0;
	const reservations = new Map<string, BudgetReservation>();
	try {
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as Partial<BudgetEntry>;
				if (entry.kind === "reservation") {
					if (typeof entry.reservationId === "string" && typeof entry.sourceRunId === "string" && typeof entry.expiresAt === "number" && entry.expiresAt > now) {
						reservations.set(entry.reservationId, { reservationId: entry.reservationId, sourceRunId: entry.sourceRunId, tokens: Math.max(0, Number(entry.tokens) || 0), costUsd: Math.max(0, Number(entry.costUsd) || 0), expiresAt: entry.expiresAt });
					}
					continue;
				}
				if (entry.kind === "reservation_released" && typeof entry.reservationId === "string") {
					reservations.delete(entry.reservationId);
					continue;
				}
				if (typeof entry.tokens === "number" && Number.isFinite(entry.tokens)) totalTokens += Math.max(0, entry.tokens);
				if (typeof entry.costUsd === "number" && Number.isFinite(entry.costUsd)) costUsd += Math.max(0, entry.costUsd);
			} catch {}
		}
	} catch {}
	let reservedTokens = 0;
	let reservedCostUsd = 0;
	for (const reservation of reservations.values()) {
		reservedTokens += reservation.tokens;
		reservedCostUsd += reservation.costUsd;
	}
	return { totalTokens, costUsd, reservedTokens, reservedCostUsd, reservations };
}

export function recordBudgetUsage(sourceRunId: string, usage: { totalTokens?: number; costUsd?: number }): boolean {
	const budget = activeOrchestrationBudget();
	if (!budget || !sourceRunId) return false;
	const tokens = Number(usage.totalTokens ?? 0);
	const costUsd = Number(usage.costUsd ?? 0);
	if (!Number.isFinite(tokens) || !Number.isFinite(costUsd) || tokens < 0 || costUsd < 0) return false;
	try {
		const result = withBudgetLock(budget.file, () => {
		const state = readBudgetState(budget.file);
		const existing = [...stateForUsages(budget.file)].some((entry) => entry.sourceRunId === sourceRunId);
		if (existing) return false;
		const withinBudget = state.totalTokens + tokens <= budget.maxTokens && state.costUsd + costUsd <= budget.maxCostUsd;
		const reservation = [...state.reservations.values()].find((entry) => entry.sourceRunId === sourceRunId);
		if (reservation) appendFileSync(budget.file, JSON.stringify({ kind: "reservation_released", reservationId: reservation.reservationId, sourceRunId, tokens: 0, costUsd: 0, recordedAt: Date.now() }) + "\n", "utf8");
		// Record actual usage even when it crosses the ceiling. Otherwise the
		// ledger understates spend and a later preflight could incorrectly pass.
		appendFileSync(budget.file, JSON.stringify({ sourceRunId, tokens, costUsd, recordedAt: Date.now() }) + "\n", "utf8");
		return withinBudget;
		});
		return result ?? false;
	} catch { return false; }
}

function stateForUsages(file: string): BudgetEntry[] {
	try {
		return readFileSync(file, "utf8").split("\n").flatMap((line) => {
			try {
				const entry = JSON.parse(line) as BudgetEntry;
				return entry.kind === "reservation" || entry.kind === "reservation_released" ? [] : [entry];
			} catch { return []; }
		});
	} catch { return []; }
}

/** Atomically reserve one worker's estimated admission slice. */
export function reserveBudget(sourceRunId: string, tokens: number, costUsd: number, ttlMs = 15 * 60_000): BudgetReservation | undefined {
	const budget = activeOrchestrationBudget();
	if (!budget || !sourceRunId) return undefined;
	if (!Number.isFinite(tokens) || !Number.isFinite(costUsd) || tokens <= 0 || costUsd <= 0) return undefined;
	const safeTokens = Math.ceil(tokens);
	const safeCost = Math.round(costUsd * 1e6) / 1e6;
	const expiresAt = Date.now() + Math.max(30_000, Math.min(ttlMs, 24 * 60 * 60_000));
	try {
		return withBudgetLock(budget.file, () => {
			const state = readBudgetState(budget.file);
			const existing = [...state.reservations.values()].find((entry) => entry.sourceRunId === sourceRunId);
			if (existing) return existing;
			if (stateForUsages(budget.file).some((entry) => entry.sourceRunId === sourceRunId)) return undefined;
			if (state.totalTokens + state.reservedTokens + safeTokens > budget.maxTokens || state.costUsd + state.reservedCostUsd + safeCost > budget.maxCostUsd) return undefined;
			const reservation = { reservationId: randomUUID(), sourceRunId, tokens: safeTokens, costUsd: safeCost, expiresAt };
			appendFileSync(budget.file, JSON.stringify({ kind: "reservation", ...reservation, recordedAt: Date.now() }) + "\n", "utf8");
			return reservation;
		}) ?? undefined;
	} catch { return undefined; }
}

/** Estimate one bounded worker share without serializing the whole budget. */
export function defaultBudgetReservation(ttlMs = 15 * 60_000): { tokens: number; costUsd: number; ttlMs: number } | undefined {
	const budget = activeOrchestrationBudget();
	if (!budget) return undefined;
	return {
		tokens: Math.max(1, budget.maxTokens / DEFAULT_RESERVATION_SLOTS),
		costUsd: Math.max(0.000001, budget.maxCostUsd / DEFAULT_RESERVATION_SLOTS),
		ttlMs: Math.max(30_000, ttlMs),
	};
}

export function releaseBudgetReservation(reservation: BudgetReservation): boolean {
	const budget = activeOrchestrationBudget();
	if (!budget) return false;
	try {
		return withBudgetLock(budget.file, () => {
			const active = readBudgetState(budget.file).reservations.has(reservation.reservationId);
			if (!active) return false;
			appendFileSync(budget.file, JSON.stringify({ kind: "reservation_released", reservationId: reservation.reservationId, sourceRunId: reservation.sourceRunId, tokens: 0, costUsd: 0, recordedAt: Date.now() }) + "\n", "utf8");
			return true;
		}) ?? false;
	} catch { return false; }
}

export function budgetStatus(): string | undefined {
	const budget = activeOrchestrationBudget();
	if (!budget) return undefined;
	return `${budget.totalTokens}/${budget.maxTokens} tokens · $${budget.costUsd.toFixed(4)}/$${budget.maxCostUsd.toFixed(4)} · reserved ${budget.reservedTokens}tok/$${budget.reservedCostUsd.toFixed(4)}`;
}

export function budgetBlockReason(): string | undefined {
	const budget = activeOrchestrationBudget();
	if (!budget) return undefined;
	if (budget.totalTokens >= budget.maxTokens) return `shared token budget exhausted (${budget.totalTokens}/${budget.maxTokens})`;
	if (budget.costUsd >= budget.maxCostUsd) return `shared cost budget exhausted ($${budget.costUsd.toFixed(4)}/$${budget.maxCostUsd.toFixed(4)})`;
	if (budget.totalTokens + budget.reservedTokens >= budget.maxTokens) return `shared token budget committed (${budget.totalTokens}+${budget.reservedTokens}/${budget.maxTokens})`;
	if (budget.costUsd + budget.reservedCostUsd >= budget.maxCostUsd) return `shared cost budget committed ($${budget.costUsd.toFixed(4)}+$${budget.reservedCostUsd.toFixed(4)})`;
	return undefined;
}
