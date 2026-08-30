// ABOUTME: Runtime evidence and append-only execution event storage.
// ABOUTME: Evidence is separated from worker claims so verifiers can rank trust correctly.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Evidence {
	id: string;
	type: "command" | "test" | "diff" | "file" | "review";
	source: "runtime" | "worker_claim";
	value: string;
	outputPath?: string;
	timestamp: string;
}

export interface RunEvent {
	id: string;
	type: string;
	actor: string;
	timestamp: string;
	payload?: unknown;
}

function appendJsonLine(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, JSON.stringify(value) + "\n", "utf8");
}

export function evidencePath(runDir: string): string { return join(runDir, "evidence.jsonl"); }
export function eventsPath(runDir: string): string { return join(runDir, "events.jsonl"); }

export function recordEvidence(runDir: string, evidence: Evidence): void {
	appendJsonLine(evidencePath(runDir), evidence);
}

export function recordRunEvent(runDir: string, event: RunEvent): void {
	appendJsonLine(eventsPath(runDir), event);
}

function readJsonLines<T>(path: string): T[] {
	if (!existsSync(path)) return [];
	try {
		return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap(line => {
			try { return [JSON.parse(line) as T]; } catch { return []; }
		});
	} catch { return []; }
}

export function listEvidence(runDir: string): Evidence[] { return readJsonLines<Evidence>(evidencePath(runDir)); }
export function listRunEvents(runDir: string): RunEvent[] { return readJsonLines<RunEvent>(eventsPath(runDir)); }
