// ABOUTME: In-memory run context for orchestrated executions.
// ABOUTME: Gives each execution an identity, bounded step budget, and an abort
// signal — without any disk persistence. The on-disk composition ledger was
// removed: it wrote git workspace fingerprints + events.jsonl per run that no
// read surface consumed (workspace-rooted readers could not see session-rooted
// writes), and the home-ledger dirs were never swept.

import { randomUUID } from "node:crypto";
import { budgetUsageExceededReason } from "./orchestration-budget.ts";
import { AGENT_PI_CONFIG } from "./agent-pi-config.ts";
import { saveRetrospective } from "./workflow-memory.ts";

export interface RunBudget {
	maxSteps: number;
	maxDurationMs: number;
	maxTokens?: number;
	maxCostUsd?: number;
}

/** Shared default deadline for mode-owned worker executions. */
export const DEFAULT_ORCHESTRATION_TIMEOUT_MS = AGENT_PI_CONFIG.workers.timeoutsMs.default;

export interface RunUsage {
	totalTokens: number;
	costUsd: number;
}

export interface OrchestrationRun {
	runId: string;
	parentRunId?: string;
	mode?: string;
	startedAt: number;
	budget: RunBudget;
	stepsUsed: number;
	usage: RunUsage;
	budgetExceeded: boolean;
	events: RunEventRecord[];
	signal: AbortSignal;
	cancel(reason?: string): void;
	consumeStep(): void;
	/** Add measured provider usage and return whether the run remains within its optional ceiling. */
	recordUsage(usage: Partial<RunUsage>): boolean;
	record(type: string, payload?: unknown): void;
	finish(status: "succeeded" | "failed" | "cancelled", payload?: unknown): void;
}

export interface RunEventRecord {
	id: string;
	runId: string;
	type: string;
	actor: string;
	timestamp: string;
	payload?: unknown;
}

export class RunBudgetError extends Error {
	readonly code = "RUN_BUDGET_EXCEEDED";
}

export function createOrchestrationRun(options: {
	context?: any;
	parentRunId?: string;
	budget?: Partial<RunBudget>;
	actor?: string;
	/** Operational mode that initiated this run, when known. */
	mode?: string;
	/** External cancellation boundary inherited by this run. */
	signal?: AbortSignal;
} = {}): OrchestrationRun {
	const runId = randomUUID();
	const startedAt = Date.now();
	const budget: RunBudget = {
		maxSteps: Math.max(1, Math.min(options.budget?.maxSteps ?? AGENT_PI_CONFIG.orchestration!.maxSteps!, 64)),
		maxDurationMs: Math.max(1_000, Math.min(options.budget?.maxDurationMs ?? 15 * 60_000, 60 * 60_000)),
		...(options.budget?.maxTokens === undefined ? {} : { maxTokens: Math.max(1, options.budget.maxTokens) }),
		...(options.budget?.maxCostUsd === undefined ? {} : { maxCostUsd: Math.max(0, options.budget.maxCostUsd) }),
	};
	const events: RunEventRecord[] = [];
	const usage: RunUsage = { totalTokens: 0, costUsd: 0 };
	let finished = false;
	let budgetExceeded = false;
	const abortController = new AbortController();
	const onExternalAbort = () => abortController.abort(options.signal?.reason || "aborted");
	if (options.signal?.aborted) onExternalAbort();
	else options.signal?.addEventListener("abort", onExternalAbort, { once: true });
	const actor = options.actor ?? "orchestration";
	const record = (type: string, payload?: unknown): void => {
		events.push({ id: randomUUID(), runId, type, actor, timestamp: new Date().toISOString(), ...(payload === undefined ? {} : { payload }) });
	};
	const run: OrchestrationRun = {
		runId,
		...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
		...(options.mode ? { mode: options.mode } : {}),
		startedAt,
		budget,
		stepsUsed: 0,
		usage,
		budgetExceeded: false,
		events,
		signal: abortController.signal,
		cancel(reason = "cancelled") {
			if (!abortController.signal.aborted) {
				record("run.cancel.requested", { reason });
				abortController.abort(reason);
			}
		},
		consumeStep() {
			if (budgetExceeded) throw new RunBudgetError(`Run ${runId} cannot start another step after exceeding its token/cost budget`);
			if (this.stepsUsed >= budget.maxSteps) throw new RunBudgetError(`Run ${runId} exceeded maxSteps=${budget.maxSteps}`);
			if (Date.now() - startedAt > budget.maxDurationMs) throw new RunBudgetError(`Run ${runId} exceeded maxDurationMs=${budget.maxDurationMs}`);
			this.stepsUsed += 1;
		},
		recordUsage(delta) {
			const tokens = Number(delta.totalTokens ?? 0);
			const costUsd = Number(delta.costUsd ?? 0);
			if (!Number.isFinite(tokens) || !Number.isFinite(costUsd) || tokens < 0 || costUsd < 0) return false;
			this.usage.totalTokens += Math.floor(tokens);
			this.usage.costUsd = Math.round((this.usage.costUsd + costUsd) * 1e6) / 1e6;
			record("usage.updated", { totalTokens: this.usage.totalTokens, costUsd: this.usage.costUsd, delta: { totalTokens: Math.floor(tokens), costUsd } });
			const within = (budget.maxTokens === undefined || this.usage.totalTokens <= budget.maxTokens)
				&& (budget.maxCostUsd === undefined || this.usage.costUsd <= budget.maxCostUsd);
			if (!within && !budgetExceeded) {
				budgetExceeded = true;
				const reason = "run token/cost ceiling exceeded";
				record("budget.exceeded", { usage: this.usage, budget, reason });
				this.cancel("budget_exceeded");
			}
			const globalReason = budgetUsageExceededReason();
			if (globalReason && !budgetExceeded) {
				budgetExceeded = true;
				this.budgetExceeded = true;
				record("budget.exceeded", { usage: this.usage, reason: globalReason, scope: "shared" });
				this.cancel("shared_budget_exceeded");
			}
			this.budgetExceeded = budgetExceeded;
			return within;
		},
		record,
		finish(status, payload) {
			if (finished) return;
			finished = true;
			const durationMs = Date.now() - startedAt;
			if (durationMs > budget.maxDurationMs && !budgetExceeded) {
				budgetExceeded = true;
				this.budgetExceeded = true;
				record("budget.exceeded", { reason: "maxDurationMs", durationMs, budget });
			}
			const terminalStatus = status === "succeeded" && budgetExceeded ? "failed" : status;
			record(`run.${terminalStatus}`, {
				stepsUsed: this.stepsUsed,
				durationMs,
				usage,
				...(budgetExceeded ? { budgetExceeded: true } : {}),
				...(payload === undefined ? {} : { result: payload }),
			});
			const retrospectiveCwd = options.context?.cwd;
			if (AGENT_PI_CONFIG.workflowSupport?.enabled && AGENT_PI_CONFIG.workflowSupport.retrospective
				&& typeof retrospectiveCwd === "string" && /^(subagent|team|chain|pipeline)/i.test(actor)) {
				try {
					saveRetrospective(retrospectiveCwd, { runId, actor, mode: options.mode, status: terminalStatus,
						durationMs, stepsUsed: this.stepsUsed, usage,
						evidenceRefs: events.filter(e => e.type.startsWith("run.")).map(e => `run:${runId}:event:${e.id}`) });
				} catch { record("retrospective.unavailable", { reason: "Workspace storage unavailable or rejected" }); }
			}
			options.signal?.removeEventListener("abort", onExternalAbort);
		},
	};
	record("run.started", { parentRunId: options.parentRunId, mode: options.mode, budget });
	return run;
}
