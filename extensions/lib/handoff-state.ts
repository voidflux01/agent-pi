// ABOUTME: Durable, compact handoff snapshots for continuing work across Pi sessions.
// ABOUTME: The snapshot is a projection of task/journal/verification facts; it is not a second source of truth.

import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type HandoffStatus = "in_progress" | "completed" | "interrupted";

export interface HandoffTask {
	id: number;
	text: string;
	status: string;
}

export interface HandoffChild {
	id: string;
	agent: string;
	status: string;
	task?: string;
	outputFile?: string;
	sessionFile?: string;
	resumed?: boolean;
}

export type ObjectiveSource = "session-state" | "task-list" | "research" | "branch";

export interface HandoffContextLink {
	todoPath?: string;
	researchSession?: { id: string; goal: string; status: string; updatedAt: string };
	reports?: string[];
}

export interface HandoffSnapshot {
	version: 1;
	workspace: string;
	sessionId?: string;
	parentSessionId?: string;
	status: HandoffStatus;
	objective: string;
	objectiveSource?: ObjectiveSource;
	mode: string;
	activeChain?: string | null;
	activePipeline?: string | null;
	tasks: HandoffTask[];
	children: HandoffChild[];
	childrenOmitted?: number;
	context?: HandoffContextLink;
	nextAction?: string;
	verification?: {
		status: string;
		attempt?: number;
		contractFingerprint?: string;
	};
	updatedAt: string;
}

export const HANDOFF_FILE = "handoff.json";
const MAX_OBJECTIVE = 1200;
const MAX_TASKS = 40;
const MAX_CHILDREN = 8;
const MAX_TASK_TEXT = 500;
const MAX_CHILD_TASK = 200;
const MAX_NEXT_ACTION = 160;
const MAX_REPORTS = 3;

// Children that still need a worker are the actionable handoff payload; failed
// rows come next; terminal rows are noise and are dropped first by the sort.
function childPriority(status: string): number {
	if (status === "running" || status === "queued" || status === "waiting") return 0;
	if (status === "failed") return 1;
	return 2;
}

export function handoffPath(workspace: string): string {
	return join(workspace, ".pi", HANDOFF_FILE);
}

function canonicalWorkspace(workspace: string, relativeTo?: string): string {
	const candidate = relativeTo && !isAbsolute(workspace) ? resolve(relativeTo, workspace) : workspace;
	try {
		return realpathSync(candidate);
	} catch {
		return resolve(candidate);
	}
}

function trim(value: unknown, max: number): string {
	return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function shortNextAction(value: string): string {
	const trimmed = value.replace(/\s+/g, " ").trim();
	return trimmed.length > MAX_NEXT_ACTION ? `${trimmed.slice(0, MAX_NEXT_ACTION - 1)}…` : trimmed;
}

export function readHandoff(workspace: string): HandoffSnapshot | undefined {
	try {
		const parsed = JSON.parse(readFileSync(handoffPath(workspace), "utf8")) as HandoffSnapshot;
		if (
			parsed?.version !== 1 ||
			typeof parsed.workspace !== "string" ||
			canonicalWorkspace(parsed.workspace, workspace) !== canonicalWorkspace(workspace) ||
			typeof parsed.objective !== "string" ||
			!(["in_progress", "completed", "interrupted"] as string[]).includes(parsed.status) ||
			typeof parsed.mode !== "string" ||
			!Array.isArray(parsed.tasks) ||
			!Array.isArray(parsed.children)
		) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

export function writeHandoff(workspace: string, snapshot: HandoffSnapshot): string {
	const path = handoffPath(workspace);
	const dir = join(workspace, ".pi");
	mkdirSync(dir, { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
	renameSync(tmp, path);
	return path;
}

export function buildHandoffSnapshot(input: {
	workspace: string;
	sessionId?: string;
	parentSessionId?: string;
	objective?: string;
	mode?: string;
	activeChain?: string | null;
	activePipeline?: string | null;
	tasks?: Array<{ id: number; text: string; status: string }>;
	children?: Array<{ id: string; agent: string; status: string; task?: string; outputFile?: string; resumed?: boolean }>;
	nextAction?: string;
	objectiveSource?: ObjectiveSource;
	context?: HandoffContextLink;
	verification?: { status: string; attempt?: number; contractFingerprint?: string };
	status?: HandoffStatus;
}): HandoffSnapshot {
	const tasks = (input.tasks ?? []).slice(0, MAX_TASKS).map((task) => ({
		id: task.id,
		text: trim(task.text, MAX_TASK_TEXT),
		status: trim(task.status, 32),
	}));
	const childRows = [...input.children ?? []]
		.map((child) => ({ ...child, status: trim(child.status, 32) }))
		.sort((a, b) => childPriority(a.status) - childPriority(b.status));
	const children = childRows.slice(0, MAX_CHILDREN).map((child) => ({
		id: trim(child.id, 160),
		agent: trim(child.agent, 80),
		status: child.status,
		...(child.task ? { task: trim(child.task, MAX_CHILD_TASK) } : {}),
		...(child.outputFile ? { outputFile: trim(child.outputFile, 300) } : {}),
		...(child.sessionFile ? { sessionFile: trim(child.sessionFile, 300) } : {}),
		...(child.resumed ? { resumed: true } : {}),
	}));
	const childrenOmitted = Math.max(0, childRows.filter((child) => childPriority(child.status) < 2).length - children.length);
	const context = input.context ? {
		...(input.context.todoPath ? { todoPath: trim(input.context.todoPath, 300) } : {}),
		...(input.context.researchSession ? {
			researchSession: {
				id: trim(input.context.researchSession.id, 160),
				goal: trim(input.context.researchSession.goal, MAX_TASK_TEXT),
				status: trim(input.context.researchSession.status, 32),
				updatedAt: trim(input.context.researchSession.updatedAt, 40),
			},
		} : {}),
		...(input.context.reports?.length ? { reports: input.context.reports.slice(0, MAX_REPORTS).map((report) => trim(report, 200)) } : {}),
	} : undefined;
	return {
		version: 1,
		workspace: input.workspace,
		...(input.sessionId ? { sessionId: input.sessionId } : {}),
		...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
		status: input.status ?? "in_progress",
		objective: trim(input.objective, MAX_OBJECTIVE),
		...(input.objectiveSource ? { objectiveSource: input.objectiveSource } : {}),
		mode: trim(input.mode || "NORMAL", 32),
		activeChain: input.activeChain ?? null,
		activePipeline: input.activePipeline ?? null,
		tasks,
		children,
		...(childrenOmitted > 0 ? { childrenOmitted } : {}),
		...(context ? { context } : {}),
		...(input.nextAction ? { nextAction: shortNextAction(input.nextAction) } : {}),
		...(input.verification ? { verification: input.verification } : {}),
		updatedAt: new Date().toISOString(),
	};
}

export function renderHandoff(snapshot: HandoffSnapshot): string {
	const lines = [
		`Status: ${snapshot.status}`,
		`Mode: ${snapshot.mode}`,
		`Objective: ${snapshot.objective || "(not recorded)"}${snapshot.objectiveSource ? ` (source: ${snapshot.objectiveSource})` : ""}`,
	];
	if (snapshot.nextAction) lines.push(`Next action: ${snapshot.nextAction}`);
	if (snapshot.tasks.length) {
		lines.push("Tasks:");
		for (const task of snapshot.tasks) lines.push(`- [${task.status}] #${task.id} ${task.text}`);
	}
	if (snapshot.children.length) {
		lines.push("Children:");
		for (const child of snapshot.children) {
			const locations = [child.sessionFile, child.outputFile].filter(Boolean).join(" | ");
			lines.push(`- [${child.status}] ${child.agent} ${child.id}: ${child.task || "(recorded child task)"}${locations ? ` — ${locations}` : ""}`);
		}
		if (snapshot.childrenOmitted) lines.push(`- … and ${snapshot.childrenOmitted} more omitted child runs`);
	}
	if (snapshot.context) {
		lines.push("Context:");
		if (snapshot.context.todoPath) lines.push(`- Plan: ${snapshot.context.todoPath}`);
		if (snapshot.context.researchSession) {
			lines.push(`- Research: ${snapshot.context.researchSession.id} [${snapshot.context.researchSession.status}] ${snapshot.context.researchSession.goal}`);
		}
		if (snapshot.context.reports?.length) lines.push(`- Reports: ${snapshot.context.reports.join(", ")}`);
	}
	if (snapshot.verification) lines.push(`Verification: ${snapshot.verification.status}`);
	lines.push(`Updated: ${snapshot.updatedAt}`);
	return lines.join("\n");
}

export function renderHandoffPrompt(snapshot: HandoffSnapshot): string {
	return `## Resumable task handoff
A previous Pi session left this compact handoff. Use it only when the user's current request continues this work; otherwise ignore it.
Do not treat claims as proof: inspect the listed next evidence and run verification before declaring completion.
For richer local context, read the linked files (plan, research session, reports) instead of guessing from task labels.

${renderHandoff(snapshot)}

If continuing, keep the existing objective and task statuses coherent. For each non-terminal child, re-dispatch its recorded task with the same agent role before claiming the work is complete; do not duplicate children already marked done. If the next action is unclear, ask the user rather than replaying the entire transcript.`;
}

export function hasMeaningfulHandoff(snapshot: HandoffSnapshot): boolean {
	return Boolean(snapshot.objective || snapshot.tasks.length || snapshot.children.length || snapshot.context);
}
