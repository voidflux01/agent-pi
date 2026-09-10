// ABOUTME: Deterministic, bounded adaptation between verification attempts.
// ABOUTME: Persists redacted observations, never changes rules or approval state.
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readBounded, redactEvidence, safeWorkspacePath } from "./workflow-artifacts.ts";
import { workflowDirection } from "./workflow-direction.ts";

export type IterationAction = "REPAIR" | "REPLAN" | "COMPLETE" | "BLOCKED" | "ESCALATE";
export type IterationFailure = "implementation" | "assumption" | "requirements" | "environment" | "evidence";

export interface IterationObservation {
	runId: string;
	parentRunId?: string;
	mode: string;
	contractFingerprint: string;
	status: "PASS" | "FAIL" | "BLOCKED" | "ESCALATE";
	attempt: number;
	failure?: IterationFailure;
	failureSignature?: string;
	evidenceRefs: string[];
	changedFiles: string[];
	createdAt: string;
}

export interface IterationDecision {
	action: IterationAction;
	reason: string;
	attempts: number;
	nextMode?: "PLAN" | "SPEC";
	requiresApproval: boolean;
}

const MAX_STORED = 20;
const MAX_TEXT = 240;
const VALID_FAILURES = new Set<IterationFailure>(["implementation", "assumption", "requirements", "environment", "evidence"]);

function cleanObservation(raw: unknown): IterationObservation | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const value = raw as Partial<IterationObservation>;
	if (typeof value.runId !== "string" || !/^[a-zA-Z0-9-]{1,120}$/.test(value.runId)) return undefined;
	if (typeof value.mode !== "string" || typeof value.contractFingerprint !== "string") return undefined;
	if (!["PASS", "FAIL", "BLOCKED", "ESCALATE"].includes(value.status ?? "")) return undefined;
	if (!Number.isInteger(value.attempt) || (value.attempt ?? 0) < 0) return undefined;
	if (value.failure !== undefined && !VALID_FAILURES.has(value.failure)) return undefined;
	const status = value.status as IterationObservation["status"];
	const attempt = value.attempt as number;
	return {
		runId: value.runId,
		parentRunId: typeof value.parentRunId === "string" ? value.parentRunId.slice(0, 120) : undefined,
		mode: redactEvidence(value.mode).slice(0, 40),
		contractFingerprint: value.contractFingerprint.slice(0, 128),
		status,
		attempt,
		failure: value.failure,
		failureSignature: typeof value.failureSignature === "string" ? redactEvidence(value.failureSignature).slice(0, MAX_TEXT) : undefined,
		evidenceRefs: (Array.isArray(value.evidenceRefs) ? value.evidenceRefs : []).filter((item): item is string => typeof item === "string").map(item => redactEvidence(item).slice(0, MAX_TEXT)).slice(0, 20),
		changedFiles: (Array.isArray(value.changedFiles) ? value.changedFiles : []).filter((item): item is string => typeof item === "string").map(item => redactEvidence(item).slice(0, 240)).slice(0, 50),
		createdAt: typeof value.createdAt === "string" ? value.createdAt.slice(0, 40) : new Date().toISOString(),
	};
}

export function decideIteration(input: { observation: IterationObservation; previous: IterationObservation[]; maxIterations: number; repairAvailable: boolean; risk?: "low" | "medium" | "high" }): IterationDecision {
	const { observation, previous } = input;
	if (observation.status === "PASS") return { action: "COMPLETE", reason: "Verifier passed with current evidence.", attempts: observation.attempt, requiresApproval: false };
	if (input.risk === "high") return { action: "ESCALATE", reason: "High-risk outcome requires human decision.", attempts: observation.attempt, requiresApproval: true };
	if (observation.status === "BLOCKED") return { action: "BLOCKED", reason: "Verification is blocked; resolve missing evidence or environment first.", attempts: observation.attempt, requiresApproval: false };
	if (observation.status === "ESCALATE") return { action: "ESCALATE", reason: "Verification escalated and must not retry silently.", attempts: observation.attempt, requiresApproval: true };
	const direction = workflowDirection({ status: "FAIL", failure: observation.failure === "evidence" ? "environment" : observation.failure, attempt: observation.attempt });
	if (observation.failure === "requirements" || observation.failure === "assumption") return { action: "REPLAN", nextMode: observation.failure === "requirements" ? "SPEC" : "PLAN", reason: direction.reason, attempts: observation.attempt, requiresApproval: true };
	const repeated = !!observation.failureSignature && previous.some(item => item.failureSignature === observation.failureSignature);
	if (repeated) return { action: "REPLAN", nextMode: "PLAN", reason: "Repeated verifier failure signature; re-plan before another implementation attempt.", attempts: observation.attempt, requiresApproval: true };
	if (observation.attempt >= input.maxIterations) return { action: "ESCALATE", reason: "Maximum iteration attempts reached.", attempts: observation.attempt, requiresApproval: true };
	if (observation.failure === "environment" || observation.failure === "evidence" || !input.repairAvailable) return { action: "BLOCKED", reason: observation.failure === "environment" ? "Environment failure cannot be repaired silently." : observation.failure === "evidence" ? "Required evidence is missing." : "No repair dispatcher is available.", attempts: observation.attempt, requiresApproval: false };
	if (observation.failure === "implementation") return { action: "REPAIR", reason: "Actionable implementation failure has not repeated; use bounded repair.", attempts: observation.attempt, requiresApproval: false };
	return { action: "ESCALATE", reason: "Failure cause is unknown; fail closed.", attempts: observation.attempt, requiresApproval: true };
}

function iterationPath(cwd: string, contractFingerprint: string): string {
	if (!/^[a-f0-9]{16,128}$/i.test(contractFingerprint)) throw new Error("Invalid contract fingerprint");
	return safeWorkspacePath(cwd, join(".pi/workflow/iterations", `${contractFingerprint}.json`));
}

export function loadIteration(cwd: string, contractFingerprint: string): IterationObservation[] {
	try {
		const path = iterationPath(cwd, contractFingerprint);
		if (!existsSync(path)) return [];
		const record = JSON.parse(readBounded(cwd, join(".pi/workflow/iterations", `${contractFingerprint}.json`)));
		if (record?.schema_version !== 1 || record.contractFingerprint !== contractFingerprint || !Array.isArray(record.observations)) return [];
		return record.observations.map(cleanObservation).filter((item: IterationObservation | undefined): item is IterationObservation => !!item).slice(-MAX_STORED);
	} catch { return []; }
}

export function recordIteration(cwd: string, observation: IterationObservation): void {
	const clean = cleanObservation(observation);
	if (!clean) throw new Error("Invalid iteration observation");
	const observations = [...loadIteration(cwd, clean.contractFingerprint), clean].slice(-MAX_STORED);
	const path = iterationPath(cwd, clean.contractFingerprint);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	// Fields are redacted individually in cleanObservation; redacting the serialized
	// blob as well could match across JSON structure and corrupt the record.
	writeFileSync(temporary, JSON.stringify({ schema_version: 1, contractFingerprint: clean.contractFingerprint, observations }, null, 2) + "\n", { mode: 0o600 });
	renameSync(temporary, path);
}

