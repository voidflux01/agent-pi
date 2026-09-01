// ABOUTME: Runtime evidence and append-only execution event storage.
// ABOUTME: Evidence is separated from worker claims so verifiers can rank trust correctly.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const MAX_EVIDENCE_VALUE_CHARS = 64 * 1024;
export const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;
const PAYLOAD_PREVIEW_CHARS = 1024;

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

function boundedPayload(payload: unknown): unknown {
	let encoded: string;
	try { encoded = JSON.stringify(payload); } catch { return { truncated: true, serializationError: true }; }
	if (Buffer.byteLength(encoded, "utf8") <= MAX_EVENT_PAYLOAD_BYTES) return payload;
	return {
		truncated: true,
		originalBytes: Buffer.byteLength(encoded, "utf8"),
		preview: encoded.slice(0, PAYLOAD_PREVIEW_CHARS),
	};
}

export function evidencePath(runDir: string): string { return join(runDir, "evidence.jsonl"); }
export function eventsPath(runDir: string): string { return join(runDir, "events.jsonl"); }

export function recordEvidence(runDir: string, evidence: Evidence): void {
	const value = evidence.value.length > MAX_EVIDENCE_VALUE_CHARS
		? `${evidence.value.slice(0, MAX_EVIDENCE_VALUE_CHARS)}\n[… evidence value truncated …]`
		: evidence.value;
	appendJsonLine(evidencePath(runDir), { ...evidence, value });
}

export function recordRunEvent(runDir: string, event: RunEvent): void {
	appendJsonLine(eventsPath(runDir), { ...event, ...(event.payload === undefined ? {} : { payload: boundedPayload(event.payload) }) });
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
