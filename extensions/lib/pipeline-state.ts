// ABOUTME: Atomic durable snapshot for the PIPELINE workflow projection.
// ABOUTME: It restores phase/context intent after restart without replacing the journal.

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type PipelineSnapshotPhase = {
	name: string;
	status: "pending" | "active" | "done" | "error" | "skipped";
	summary: string;
	dispatchCount: number;
	lastDispatchSuccess: boolean;
};

export interface PipelineSnapshot {
	version: 1;
	pipeline: string;
	currentPhaseIndex: number;
	taskSummary: string;
	accContext: string;
	planOutput: string;
	reviewOutput: string;
	reviewLoopCount: number;
	phases: PipelineSnapshotPhase[];
	updatedAt: string;
}

export function pipelineSnapshotMatchesPhaseNames(snapshot: PipelineSnapshot | undefined, phaseNames: string[]): boolean {
	return Boolean(
		snapshot &&
		snapshot.phases.length === phaseNames.length &&
		snapshot.phases.every((phase, index) => phase.name === phaseNames[index]),
	);
}

export function pipelineSnapshotPath(sessionDir: string): string { return join(sessionDir, "pipeline-state.json"); }

export function readPipelineSnapshot(sessionDir: string): PipelineSnapshot | undefined {
	const path = pipelineSnapshotPath(sessionDir);
	try {
		if (!existsSync(path) || !lstatSync(path).isFile()) return undefined;
		const value = JSON.parse(readFileSync(path, "utf8")) as Partial<PipelineSnapshot>;
		if (value.version !== 1 || typeof value.pipeline !== "string" || !value.pipeline ||
			!Number.isInteger(value.currentPhaseIndex) || value.currentPhaseIndex < 0 ||
			!Array.isArray(value.phases) || typeof value.taskSummary !== "string" ||
			typeof value.accContext !== "string" || typeof value.planOutput !== "string" ||
			typeof value.reviewOutput !== "string" || !Number.isInteger(value.reviewLoopCount)) return undefined;
		const phases = value.phases.filter((phase): phase is PipelineSnapshotPhase => Boolean(
			phase && typeof phase.name === "string" &&
			["pending", "active", "done", "error", "skipped"].includes(phase.status as string) &&
			typeof phase.summary === "string" && Number.isInteger(phase.dispatchCount) && phase.dispatchCount >= 0 &&
			typeof phase.lastDispatchSuccess === "boolean",
		));
		if (phases.length !== value.phases.length || phases.length === 0 || value.currentPhaseIndex >= phases.length) return undefined;
		return { ...value, phases } as PipelineSnapshot;
	} catch { return undefined; }
}

export function writePipelineSnapshot(sessionDir: string, snapshot: Omit<PipelineSnapshot, "version" | "updatedAt">): string {
	mkdirSync(sessionDir, { recursive: true });
	const path = pipelineSnapshotPath(sessionDir);
	const tmp = `${path}.tmp-${process.pid}`;
	const payload: PipelineSnapshot = { version: 1, ...snapshot, updatedAt: new Date().toISOString() };
	writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
	renameSync(tmp, path);
	return path;
}

export function clearPipelineSnapshot(sessionDir: string): void {
	try { unlinkSync(pipelineSnapshotPath(sessionDir)); } catch {}
}
