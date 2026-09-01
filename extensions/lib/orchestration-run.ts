// ABOUTME: Shared lightweight run context for Fabric-inspired compositions.
// ABOUTME: Gives each execution an identity, bounded step budget, and optional
// session-backed event trail without replacing the existing worker journal.

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { recordRunEvent } from "./evidence-store.ts";
import { buildWorkspaceManifest, type WorkspaceManifest } from "./workspace-manifest.ts";

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

export function activeRunMarkerPath(eventDir: string): string { return join(eventDir, "active.json"); }

export class RunBudgetError extends Error {
	readonly code = "RUN_BUDGET_EXCEEDED";
}

function eventDirFromContext(context: any, runId: string, explicitSessionFile?: string, explicitEventDir?: string): string | undefined {
	if (explicitEventDir) return explicitEventDir;
	const sessionFile = explicitSessionFile || context?.sessionManager?.getSessionFile?.() || process.env.PI_SESSION_FILE;
	if (typeof sessionFile !== "string" || !sessionFile) return undefined;
	return join(dirname(sessionFile), "compositions", runId);
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
	/** Capture a bounded before/after workspace delta in the run event trail. */
	workspaceCwd?: string;
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
	const workspaceBefore = workspaceSnapshot(options.workspaceCwd);
	const activeMarker = eventDir ? activeRunMarkerPath(eventDir) : undefined;
	const events: RunEventRecord[] = [];
	let finished = false;
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
		finish(status, payload) {
			if (finished) return;
			finished = true;
			if (workspaceBefore) {
				const workspaceAfter = workspaceSnapshot(options.workspaceCwd);
				if (workspaceAfter) record("workspace.changed", {
					beforeHash: workspaceBefore.hash,
					afterHash: workspaceAfter.hash,
					changedFiles: changedWorkspaceFiles(workspaceBefore, workspaceAfter),
				});
			}
			record(`run.${status}`, { stepsUsed: this.stepsUsed, durationMs: Date.now() - startedAt, ...(payload === undefined ? {} : { result: payload }) });
			if (activeMarker) { try { unlinkSync(activeMarker); } catch {} }
		},
	};
	if (activeMarker) {
		try {
			mkdirSync(eventDir!, { recursive: true });
			writeFileSync(activeMarker, JSON.stringify({ pid: process.pid, startedAt, runId }), { mode: 0o600 });
		} catch {}
	}
	record("run.started", { parentRunId: options.parentRunId, budget });
	return run;
}
