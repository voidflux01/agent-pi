// ABOUTME: Shared lightweight run context for Fabric-inspired compositions.
// ABOUTME: Gives each execution an identity, bounded step budget, and optional
// session-backed event trail without replacing the existing worker journal.

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { recordRunEvent } from "./evidence-store.ts";
import { buildWorkspaceManifest, type WorkspaceManifest } from "./workspace-manifest.ts";
import { budgetUsageExceededReason } from "./orchestration-budget.ts";
import { AGENT_PI_CONFIG } from "./agent-pi-config.ts";

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
	eventDir?: string;
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

export function activeRunMarkerPath(eventDir: string): string { return join(eventDir, "active.json"); }

export class RunBudgetError extends Error {
	readonly code = "RUN_BUDGET_EXCEEDED";
}

function eventDirFromContext(context: any, runId: string, explicitSessionFile?: string, explicitEventDir?: string): string | undefined {
	if (explicitEventDir) return explicitEventDir;
	const sessionFile = explicitSessionFile || context?.sessionManager?.getSessionFile?.() || process.env.PI_SESSION_FILE;
	if (typeof sessionFile === "string" && sessionFile) return join(dirname(sessionFile), "compositions", runId);
	const cwd = context?.cwd;
	return typeof cwd === "string" && cwd ? join(cwd, ".pi", "agent-sessions", "compositions", runId) : undefined;
}

function workspaceSnapshot(cwd: string | undefined): WorkspaceManifest | undefined {
	if (!cwd) return undefined;
	try { return buildWorkspaceManifest(cwd, ""); } catch { return undefined; }
}

function changedWorkspaceFiles(before: WorkspaceManifest, after: WorkspaceManifest): string[] {
	const paths = new Set([...before.files.map(file => file.path), ...after.files.map(file => file.path), ...before.staged, ...after.staged, ...before.untracked, ...after.untracked]);
	return [...paths].sort().filter(path => {
		const beforeFile = before.files.find(file => file.path === path);
		const afterFile = after.files.find(file => file.path === path);
		return `${beforeFile?.size ?? "missing"}:${beforeFile?.hash ?? ""}` !== `${afterFile?.size ?? "missing"}:${afterFile?.hash ?? ""}`
			|| before.staged.includes(path) !== after.staged.includes(path)
			|| before.untracked.includes(path) !== after.untracked.includes(path);
	});
}

export function createOrchestrationRun(options: {
	context?: any;
	sessionFile?: string;
	eventDir?: string;
	parentRunId?: string;
	budget?: Partial<RunBudget>;
	actor?: string;
	/** Operational mode that initiated this run, when known. */
	mode?: string;
	/** Capture a bounded before/after workspace delta in the run event trail. */
	workspaceCwd?: string;
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
	const eventDir = eventDirFromContext(options.context, runId, options.sessionFile, options.eventDir);
	const workspaceBefore = workspaceSnapshot(options.workspaceCwd);
	const activeMarker = eventDir ? activeRunMarkerPath(eventDir) : undefined;
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
		const event: RunEventRecord = { id: randomUUID(), runId, type, actor, timestamp: new Date().toISOString(), ...(payload === undefined ? {} : { payload }) };
		events.push(event);
		if (eventDir) recordRunEvent(eventDir, { id: event.id, type: event.type, actor: event.actor, timestamp: event.timestamp, payload: { runId: event.runId, ...(event.payload === undefined ? {} : { data: event.payload }) } });
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
		...(eventDir ? { eventDir } : {}),
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
			if (workspaceBefore) {
				const workspaceAfter = workspaceSnapshot(options.workspaceCwd);
				if (workspaceAfter) record("workspace.changed", {
					beforeHash: workspaceBefore.hash,
					afterHash: workspaceAfter.hash,
					changedFiles: changedWorkspaceFiles(workspaceBefore, workspaceAfter),
				});
			}
			const terminalStatus = status === "succeeded" && budgetExceeded ? "failed" : status;
			record(`run.${terminalStatus}`, {
				stepsUsed: this.stepsUsed,
				durationMs,
				usage,
				...(budgetExceeded ? { budgetExceeded: true } : {}),
				...(payload === undefined ? {} : { result: payload }),
			});
			if (activeMarker) { try { unlinkSync(activeMarker); } catch {} }
			options.signal?.removeEventListener("abort", onExternalAbort);
		},
	};
	if (activeMarker) {
		try {
			mkdirSync(eventDir!, { recursive: true });
			writeFileSync(activeMarker, JSON.stringify({ pid: process.pid, startedAt, runId }), { mode: 0o600 });
		} catch {}
	}
	record("run.started", { parentRunId: options.parentRunId, mode: options.mode, budget });
	return run;
}
