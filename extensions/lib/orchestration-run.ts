// ABOUTME: Shared lightweight run context for Fabric-inspired compositions.
// ABOUTME: Gives each execution an identity, bounded step budget, and optional
// session-backed event trail without replacing the existing worker journal.

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { recordRunEvent } from "./evidence-store.ts";

export interface RunBudget {
	maxSteps: number;
	maxDurationMs: number;
	maxTokens?: number;
	maxCostUsd?: number;
}

export interface OrchestrationRun {
	runId: string;
	parentRunId?: string;
	startedAt: number;
	budget: RunBudget;
	stepsUsed: number;
	eventDir?: string;
	events: RunEventRecord[];
	consumeStep(): void;
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

function eventDirFromContext(context: any, runId: string, explicitSessionFile?: string, explicitEventDir?: string): string | undefined {
	if (explicitEventDir) return explicitEventDir;
	const sessionFile = explicitSessionFile || context?.sessionManager?.getSessionFile?.() || process.env.PI_SESSION_FILE;
	if (typeof sessionFile !== "string" || !sessionFile) return undefined;
	return join(dirname(sessionFile), "compositions", runId);
}

export function createOrchestrationRun(options: {
	context?: any;
	sessionFile?: string;
	eventDir?: string;
	parentRunId?: string;
	budget?: Partial<RunBudget>;
	actor?: string;
} = {}): OrchestrationRun {
	const runId = randomUUID();
	const startedAt = Date.now();
	const budget: RunBudget = {
		maxSteps: Math.max(1, Math.min(options.budget?.maxSteps ?? 16, 64)),
		maxDurationMs: Math.max(1_000, Math.min(options.budget?.maxDurationMs ?? 15 * 60_000, 60 * 60_000)),
		...(options.budget?.maxTokens === undefined ? {} : { maxTokens: Math.max(1, options.budget.maxTokens) }),
		...(options.budget?.maxCostUsd === undefined ? {} : { maxCostUsd: Math.max(0, options.budget.maxCostUsd) }),
	};
	const eventDir = eventDirFromContext(options.context, runId, options.sessionFile, options.eventDir);
	const events: RunEventRecord[] = [];
	const actor = options.actor ?? "orchestration";
	const record = (type: string, payload?: unknown): void => {
		const event: RunEventRecord = { id: randomUUID(), runId, type, actor, timestamp: new Date().toISOString(), ...(payload === undefined ? {} : { payload }) };
		events.push(event);
		if (eventDir) recordRunEvent(eventDir, { id: event.id, type: event.type, actor: event.actor, timestamp: event.timestamp, payload: { runId: event.runId, ...(event.payload === undefined ? {} : { data: event.payload }) } });
	};
	const run: OrchestrationRun = {
		runId,
		...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
		startedAt,
		budget,
		stepsUsed: 0,
		...(eventDir ? { eventDir } : {}),
		events,
		consumeStep() {
			if (this.stepsUsed >= budget.maxSteps) throw new RunBudgetError(`Run ${runId} exceeded maxSteps=${budget.maxSteps}`);
			if (Date.now() - startedAt > budget.maxDurationMs) throw new RunBudgetError(`Run ${runId} exceeded maxDurationMs=${budget.maxDurationMs}`);
			this.stepsUsed += 1;
		},
		record,
		finish(status, payload) { record(`run.${status}`, { stepsUsed: this.stepsUsed, durationMs: Date.now() - startedAt, ...(payload === undefined ? {} : { result: payload }) }); },
	};
	record("run.started", { parentRunId: options.parentRunId, budget });
	return run;
}
