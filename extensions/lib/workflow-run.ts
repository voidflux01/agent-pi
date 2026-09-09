import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { redactEvidence, safeWorkspacePath } from "./workflow-artifacts.ts";
import { getWorkflowRunLink, resetWorkflowRunLink } from "./coordination-state.ts";
import { inspectHerdrPanesAsync } from "./herdr-client.ts";

export type WorkflowRunStatus = "RUNNING" | "WAITING_APPROVAL" | "BLOCKED" | "COMPLETE" | "CANCELLED";

export interface WorkflowRunRecord {
	schema_version: 1;
	run_id: string;
	objective: string;
	status: WorkflowRunStatus;
	mode?: string;
	phase?: string;
	contract_fingerprint?: string;
	next_action?: string;
	created_at: string;
	updated_at: string;
}

const RUNS_DIR = ".pi/workflow/runs";
const MAX_RUNS = 50;
const MAX_TEXT = 4000;
const MAX_FIELD = 160;
const STATUSES = new Set<WorkflowRunStatus>(["RUNNING", "WAITING_APPROVAL", "BLOCKED", "COMPLETE", "CANCELLED"]);

function clean(value: unknown, max = MAX_FIELD): string | undefined {
	if (typeof value !== "string") return undefined;
	const result = redactEvidence(value).trim().slice(0, max);
	return result || undefined;
}

function runPath(cwd: string, runId: string): string {
	if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("Invalid workflow run id");
	return safeWorkspacePath(cwd, join(RUNS_DIR, `${runId}.json`));
}

function normalize(value: unknown, expectedRunId?: string): WorkflowRunRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const input = value as Record<string, unknown>;
	const runId = clean(input.run_id, 80);
	const objective = clean(input.objective, MAX_TEXT);
	const status = input.status;
	const createdAt = clean(input.created_at, 64);
	const updatedAt = clean(input.updated_at, 64);
	if (input.schema_version !== 1 || !runId || !/^[0-9a-f-]{36}$/i.test(runId) || (expectedRunId && runId !== expectedRunId) || !objective || typeof status !== "string" || !STATUSES.has(status as WorkflowRunStatus) || !createdAt || !updatedAt || !Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) return undefined;
	return {
		schema_version: 1,
		run_id: runId,
		objective,
		status: status as WorkflowRunStatus,
		mode: clean(input.mode),
		phase: clean(input.phase),
		contract_fingerprint: clean(input.contract_fingerprint, 128),
		next_action: clean(input.next_action, MAX_TEXT),
		created_at: createdAt,
		updated_at: updatedAt,
	};
}

function runFiles(cwd: string): string[] {
	const dir = safeWorkspacePath(cwd, RUNS_DIR);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter(name => name.endsWith(".json"))
		.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs)
		.slice(0, MAX_RUNS);
}

export function createWorkflowRun(cwd: string, objective: string): WorkflowRunRecord {
	if (runFiles(cwd).length > 0 && !loadLatestWorkflowRun(cwd)) throw new Error("Workflow run state unavailable");
	const now = new Date().toISOString();
	return {
		schema_version: 1,
		run_id: randomUUID(),
		objective: redactEvidence(objective).trim().slice(0, MAX_TEXT),
		status: "RUNNING",
		created_at: now,
		updated_at: now,
	};
}

export function saveWorkflowRun(cwd: string, record: WorkflowRunRecord): string {
	const cleanRecord = normalize(record);
	if (!cleanRecord) throw new Error("Invalid workflow run record");
	const path = runPath(cwd, cleanRecord.run_id);
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const text = JSON.stringify(cleanRecord, null, 2) + "\n";
	const temporary = safeWorkspacePath(cwd, join(RUNS_DIR, `${cleanRecord.run_id}.${process.pid}.${Date.now()}.tmp`));
	writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
	renameSync(temporary, path);
	return path;
}

export function loadWorkflowRun(cwd: string, runId: string): WorkflowRunRecord | undefined {
	try {
		return normalize(JSON.parse(readFileSync(runPath(cwd, runId), "utf8")), runId);
	} catch { return undefined; }
}

export function loadLatestWorkflowRun(cwd: string): WorkflowRunRecord | undefined {
	const records: WorkflowRunRecord[] = [];
	const seen = new Set<string>();
	for (const name of runFiles(cwd)) {
		try {
			const runId = name.slice(0, -5);
			const record = loadWorkflowRun(cwd, runId);
			if (!record || seen.has(record.run_id)) return undefined;
			seen.add(record.run_id);
			records.push(record);
		} catch { return undefined; }
	}
	return records.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0];
}

export function updateWorkflowRun(cwd: string, patch: Partial<WorkflowRunRecord>): WorkflowRunRecord | undefined {
	const current = patch.run_id ? loadWorkflowRun(cwd, patch.run_id) : loadLatestWorkflowRun(cwd);
	if (!current) return undefined;
	const next = { ...current, ...patch, run_id: current.run_id, schema_version: 1 as const, updated_at: new Date().toISOString() };
	saveWorkflowRun(cwd, next);
	return next;
}

export function markWorkflowRunBlocked(cwd: string, runId: string | undefined, nextAction: string): WorkflowRunRecord | undefined {
	if (!runId) return undefined;
	const current = loadWorkflowRun(cwd, runId);
	if (!current || current.status === "COMPLETE" || current.status === "CANCELLED" || current.status === "BLOCKED" || current.status === "WAITING_APPROVAL") return current;
	const blocked = updateWorkflowRun(cwd, { run_id: runId, status: "BLOCKED", next_action: nextAction });
	resetWorkflowRunLink(runId);
	return blocked;
}

export function markWorkflowRunComplete(cwd: string, runId: string | undefined): WorkflowRunRecord | undefined {
	if (!runId) return undefined;
	const current = loadWorkflowRun(cwd, runId);
	if (!current || current.status === "COMPLETE" || current.status === "CANCELLED") return current;
	const complete = updateWorkflowRun(cwd, { run_id: runId, status: "COMPLETE", next_action: "Workflow completed" });
	resetWorkflowRunLink(runId);
	return complete;
}

const ORPHANED_WORKFLOW_ACTION = "Previous workflow execution ended before reaching a terminal report";

export async function reconcileLatestWorkflowRun(cwd: string): Promise<WorkflowRunRecord | undefined> {
	const current = loadLatestWorkflowRun(cwd);
	if (!current || current.status !== "RUNNING") return current;
	const link = getWorkflowRunLink(cwd);
	if (link?.runId === current.run_id) return current;
	let livePane = false;
	try {
		const panes = await inspectHerdrPanesAsync(cwd);
		const ownerPanes = panes.filter((pane) => pane.workflowRunId === current.run_id);
		if (ownerPanes.some((pane) => pane.health === "unknown")) return current;
		livePane = ownerPanes.some((pane) => pane.health === "alive");
	} catch { return current; }
	return livePane ? current : updateWorkflowRun(cwd, { run_id: current.run_id, status: "BLOCKED", next_action: ORPHANED_WORKFLOW_ACTION });
}

export { ORPHANED_WORKFLOW_ACTION };

export function formatWorkflowRun(record: WorkflowRunRecord | undefined): string {
	if (!record) return "No workflow run";
	return [
		`Workflow run ${record.run_id}`,
		`Status: ${record.status}`,
		`Objective: ${redactEvidence(record.objective)}`,
		record.mode ? `Mode: ${redactEvidence(record.mode)}` : "",
		record.phase ? `Phase: ${redactEvidence(record.phase)}` : "",
		record.contract_fingerprint ? `Contract: ${redactEvidence(record.contract_fingerprint)}` : "",
		record.next_action ? `Next: ${redactEvidence(record.next_action)}` : "",
	].filter(Boolean).join("\n");
}
