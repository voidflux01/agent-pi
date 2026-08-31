// ABOUTME: Durable, compact handoff snapshots for continuing work across Pi sessions.
// ABOUTME: The snapshot is a projection of task/journal/verification facts; it is not a second source of truth.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
	resumed?: boolean;
}

export interface HandoffSnapshot {
	version: 1;
	workspace: string;
	sessionId?: string;
	parentSessionId?: string;
	status: HandoffStatus;
	objective: string;
	mode: string;
	activeChain?: string | null;
	activePipeline?: string | null;
	tasks: HandoffTask[];
	children: HandoffChild[];
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
const MAX_CHILDREN = 24;
const MAX_TASK_TEXT = 500;

export function handoffPath(workspace: string): string {
	return join(workspace, ".pi", HANDOFF_FILE);
}

function trim(value: unknown, max: number): string {
	return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function readHandoff(workspace: string): HandoffSnapshot | undefined {
	try {
		const parsed = JSON.parse(readFileSync(handoffPath(workspace), "utf8")) as HandoffSnapshot;
		if (
			parsed?.version !== 1 ||
			parsed.workspace !== workspace ||
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
	verification?: { status: string; attempt?: number; contractFingerprint?: string };
	status?: HandoffStatus;
}): HandoffSnapshot {
	const tasks = (input.tasks ?? []).slice(0, MAX_TASKS).map((task) => ({
		id: task.id,
		text: trim(task.text, MAX_TASK_TEXT),
		status: trim(task.status, 32),
	}));
	const children = (input.children ?? []).slice(-MAX_CHILDREN).map((child) => ({
		id: trim(child.id, 160),
		agent: trim(child.agent, 80),
		status: trim(child.status, 32),
		...(child.task ? { task: trim(child.task, MAX_TASK_TEXT) } : {}),
		...(child.outputFile ? { outputFile: trim(child.outputFile, 300) } : {}),
		...(child.resumed ? { resumed: true } : {}),
	}));
	return {
		version: 1,
		workspace: input.workspace,
		...(input.sessionId ? { sessionId: input.sessionId } : {}),
		...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
		status: input.status ?? "in_progress",
		objective: trim(input.objective, MAX_OBJECTIVE),
		mode: trim(input.mode || "NORMAL", 32),
		activeChain: input.activeChain ?? null,
		activePipeline: input.activePipeline ?? null,
		tasks,
		children,
		...(input.nextAction ? { nextAction: trim(input.nextAction, 800) } : {}),
		...(input.verification ? { verification: input.verification } : {}),
		updatedAt: new Date().toISOString(),
	};
}

export function renderHandoff(snapshot: HandoffSnapshot): string {
	const lines = [
		`Status: ${snapshot.status}`,
		`Mode: ${snapshot.mode}`,
		`Objective: ${snapshot.objective || "(not recorded)"}`,
	];
	if (snapshot.nextAction) lines.push(`Next action: ${snapshot.nextAction}`);
	if (snapshot.tasks.length) {
		lines.push("Tasks:");
		for (const task of snapshot.tasks) lines.push(`- [${task.status}] #${task.id} ${task.text}`);
	}
	if (snapshot.children.length) {
		lines.push("Children:");
		for (const child of snapshot.children) lines.push(`- [${child.status}] ${child.agent}: ${child.task || child.id}`);
	}
	if (snapshot.verification) lines.push(`Verification: ${snapshot.verification.status}`);
	lines.push(`Updated: ${snapshot.updatedAt}`);
	return lines.join("\n");
}

export function renderHandoffPrompt(snapshot: HandoffSnapshot): string {
	return `## Resumable task handoff
A previous Pi session left this compact handoff. Use it only when the user's current request continues this work; otherwise ignore it.
Do not treat claims as proof: inspect the listed next evidence and run verification before declaring completion.

${renderHandoff(snapshot)}

If continuing, keep the existing objective and task statuses coherent. If the next action is unclear, ask the user rather than replaying the entire transcript.`;
}

export function hasMeaningfulHandoff(snapshot: HandoffSnapshot): boolean {
	return Boolean(snapshot.objective || snapshot.tasks.length || snapshot.children.length || snapshot.mode !== "NORMAL");
}
