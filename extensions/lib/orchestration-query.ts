// ABOUTME: Read-only query layer for persisted orchestration RunContext events.
// ABOUTME: Provides one stable data source for status commands, tools, and a future dashboard.

import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listRunEvents, type RunEvent } from "./evidence-store.ts";

export interface OrchestrationRunSummary {
	runId: string;
	parentRunId?: string;
	actor: string;
	status: "running" | "succeeded" | "failed" | "cancelled" | "unknown";
	startedAt?: string;
	finishedAt?: string;
	durationMs?: number;
	eventCount: number;
	eventDir: string;
}

function statusFromEvents(events: RunEvent[]): OrchestrationRunSummary["status"] {
	const last = [...events].reverse().find((event) => event.type.startsWith("run."));
	if (!last) return "unknown";
	if (last.type === "run.succeeded") return "succeeded";
	if (last.type === "run.failed") return "failed";
	if (last.type === "run.cancelled") return "cancelled";
	return "running";
}

function payloadData(event: RunEvent): Record<string, unknown> {
	if (!event.payload || typeof event.payload !== "object") return {};
	const payload = event.payload as Record<string, unknown>;
	return payload.data && typeof payload.data === "object"
		? { ...(typeof payload.runId === "string" ? { runId: payload.runId } : {}), ...(payload.data as Record<string, unknown>) }
		: payload;
}

export function orchestrationRunsDir(cwd: string): string { return join(cwd, ".pi", "agent-sessions", "compositions"); }

export function summarizeOrchestrationRun(eventDir: string): OrchestrationRunSummary | undefined {
	const events = listRunEvents(eventDir);
	if (events.length === 0) return undefined;
	const start = events.find((event) => event.type === "run.started");
	const finish = [...events].reverse().find((event) => event.type.startsWith("run.") && event.type !== "run.started");
	const startData = start ? payloadData(start) : {};
	const finishData = finish ? payloadData(finish) : {};
	const durationMs = typeof finishData.durationMs === "number" ? finishData.durationMs : undefined;
	return {
		runId: typeof startData.runId === "string" ? startData.runId : eventDir.split("/").pop() || "unknown",
		...(typeof startData.parentRunId === "string" ? { parentRunId: startData.parentRunId } : {}),
		actor: start?.actor || events[0]?.actor || "unknown",
		status: statusFromEvents(events),
		startedAt: start?.timestamp,
		finishedAt: finish?.timestamp,
		...(durationMs === undefined ? {} : { durationMs }),
		eventCount: events.length,
		eventDir,
	};
}

export function listOrchestrationRuns(cwd: string, options: { limit?: number; runId?: string } = {}): OrchestrationRunSummary[] {
	const root = orchestrationRunsDir(cwd);
	const limit = Math.max(1, Math.min(options.limit ?? 25, 100));
	const names = options.runId ? [options.runId] : (() => {
		try { return readdirSync(root).slice(0, 200); } catch { return []; }
	})();
	return names.filter((name) => /^[A-Za-z0-9_-]{1,128}$/.test(name)).flatMap((name) => {
		const eventDir = join(root, name);
		try { if (!lstatSync(eventDir).isDirectory()) return []; } catch { return []; }
		const summary = summarizeOrchestrationRun(eventDir);
		return summary ? [summary] : [];
	}).sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || "")).slice(0, limit);
}
