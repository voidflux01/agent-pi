// ABOUTME: Canonical run statuses shared by orchestration, handoff, and viewer projections.
// ABOUTME: Accepts legacy status labels so persisted records remain backward compatible.

export type RunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown";

const STATUS_ALIASES: Record<string, RunStatus> = {
	queued: "queued", pending: "queued", dispatched: "queued", dispatching: "queued",
	running: "running", working: "running", active: "running",
	waiting: "waiting", blocked: "waiting",
	done: "succeeded", completed: "succeeded", success: "succeeded", succeeded: "succeeded",
	error: "failed", failed: "failed", dead: "failed",
	stopped: "cancelled", cancelled: "cancelled", canceled: "cancelled",
};

export function normalizeRunStatus(value: unknown): RunStatus {
	const key = String(value ?? "").trim().toLowerCase();
	return STATUS_ALIASES[key] ?? "unknown";
}

export function isTerminalRunStatus(value: unknown): boolean {
	const status = normalizeRunStatus(value);
	return status === "succeeded" || status === "failed" || status === "cancelled";
}

export function isResumableRunStatus(value: unknown): boolean {
	const status = normalizeRunStatus(value);
	return status === "queued" || status === "running" || status === "waiting" || status === "failed";
}

export function isActiveRunStatus(value: unknown): boolean {
	const status = normalizeRunStatus(value);
	return status === "queued" || status === "running" || status === "waiting";
}
