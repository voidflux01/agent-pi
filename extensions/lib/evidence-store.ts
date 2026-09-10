// ABOUTME: Runtime evidence and append-only execution evidence storage.
// ABOUTME: Evidence is separated from worker claims so verifiers can rank trust correctly.
// ABOUTME: The composition-run event store (events.jsonl) was removed with the ledger;
// ABOUTME: only verifier evidence (evidence.jsonl) remains.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const MAX_EVIDENCE_VALUE_CHARS = 64 * 1024;

export interface Evidence {
	id: string;
	type: "command" | "test" | "diff" | "file" | "review";
	source: "runtime" | "worker_claim";
	value: string;
	outputPath?: string;
	timestamp: string;
}

function appendJsonLine(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, JSON.stringify(value) + "\n", "utf8");
}

export function evidencePath(runDir: string): string { return join(runDir, "evidence.jsonl"); }

export function recordEvidence(runDir: string, evidence: Evidence): void {
	const value = evidence.value.length > MAX_EVIDENCE_VALUE_CHARS
		? `${evidence.value.slice(0, MAX_EVIDENCE_VALUE_CHARS)}\n[… evidence value truncated …]`
		: evidence.value;
	appendJsonLine(evidencePath(runDir), { ...evidence, value });
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
