// ABOUTME: Atomic durable snapshot for CHAIN progress so a restarted parent can resume safely.
// ABOUTME: The journal remains authoritative for events; this file stores only bounded workflow state.

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ChainSnapshotStep = {
	agent: string;
	status: "pending" | "running" | "done" | "error";
	elapsed: number;
	lastWork: string;
	toolCount?: number;
};

export interface ChainSnapshot {
	version: 1;
	chain: string;
	originalTask: string;
	currentStepIndex: number;
	stepOutputs: string[];
	steps: ChainSnapshotStep[];
	updatedAt: string;
}

export function chainSnapshotPath(sessionDir: string): string { return join(sessionDir, "chain-state.json"); }

export function readChainSnapshot(sessionDir: string): ChainSnapshot | undefined {
	const path = chainSnapshotPath(sessionDir);
	try {
		if (!existsSync(path) || !lstatSync(path).isFile()) return undefined;
		const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ChainSnapshot>;
		if (value.version !== 1 || typeof value.chain !== "string" || !value.chain ||
			typeof value.originalTask !== "string" || !Number.isInteger(value.currentStepIndex) || value.currentStepIndex < 0 ||
			!Array.isArray(value.stepOutputs) || !Array.isArray(value.steps) || value.steps.length === 0 ||
			value.currentStepIndex > value.steps.length) return undefined;
		const outputs = value.stepOutputs.filter((output): output is string => typeof output === "string");
		const steps = value.steps.filter((step): step is ChainSnapshotStep => Boolean(
			step && typeof step.agent === "string" &&
			["pending", "running", "done", "error"].includes(step.status as string) &&
			Number.isFinite(step.elapsed) && step.elapsed >= 0 && typeof step.lastWork === "string" &&
			(step.toolCount === undefined || (Number.isInteger(step.toolCount) && step.toolCount >= 0)),
		));
		if (outputs.length !== value.stepOutputs.length || steps.length !== value.steps.length || outputs.length > steps.length) return undefined;
		return { ...value, stepOutputs: outputs, steps } as ChainSnapshot;
	} catch { return undefined; }
}

export function writeChainSnapshot(sessionDir: string, snapshot: Omit<ChainSnapshot, "version" | "updatedAt">): string {
	mkdirSync(sessionDir, { recursive: true });
	const path = chainSnapshotPath(sessionDir);
	const tmp = `${path}.tmp-${process.pid}`;
	const bounded = {
		...snapshot,
		originalTask: snapshot.originalTask.slice(0, 16_000),
		stepOutputs: snapshot.stepOutputs.map(output => output.slice(0, 16_000)),
		steps: snapshot.steps.map(step => ({ ...step, lastWork: step.lastWork.slice(0, 2_000) })),
	};
	const payload: ChainSnapshot = { version: 1, ...bounded, updatedAt: new Date().toISOString() };
	writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
	renameSync(tmp, path);
	return path;
}

export function clearChainSnapshot(sessionDir: string): void {
	try { unlinkSync(chainSnapshotPath(sessionDir)); } catch {}
}
