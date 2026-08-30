// ABOUTME: Shared execution contract types and canonical goal hashing.
// ABOUTME: Keeps approval and verification state separate from human-facing task Markdown.

import { createHash } from "node:crypto";

export type GoalStatus = "draft" | "approved" | "running" | "verifying" | "completed" | "failed" | "blocked";
export type VerificationStatus = "PASS" | "FAIL" | "BLOCKED";

export interface EvidenceRequirement {
	id: string;
	description: string;
	type?: "command" | "test" | "diff" | "file" | "review";
}

export interface Subgoal {
	id: string;
	description: string;
	status: "pending" | "running" | "completed" | "failed" | "blocked";
}

export interface GoalContract {
	version: 1;
	id: string;
	objective: string;
	scope: string[];
	constraints: string[];
	successCriteria: string[];
	evidenceRequired: EvidenceRequirement[];
	risks: string[];
	subgoals: Subgoal[];
	status: GoalStatus;
	approvedHash?: string;
	approvedAt?: string;
}

/** Only acceptance-relevant fields participate in approval invalidation. */
export function approvalMaterial(goal: Pick<GoalContract, "objective" | "scope" | "constraints" | "successCriteria" | "evidenceRequired">): unknown {
	return {
		objective: goal.objective.trim(),
		scope: [...goal.scope].map(v => v.trim()).sort(),
		constraints: [...goal.constraints].map(v => v.trim()).sort(),
		successCriteria: [...goal.successCriteria].map(v => v.trim()).sort(),
		evidenceRequired: [...goal.evidenceRequired]
			.map(v => ({ id: v.id.trim(), description: v.description.trim(), ...(v.type ? { type: v.type } : {}) }))
			.sort((a, b) => a.id.localeCompare(b.id)),
	};
}

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	return `{${Object.keys(value as Record<string, unknown>).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function objectiveHash(goal: Pick<GoalContract, "objective" | "scope" | "constraints" | "successCriteria" | "evidenceRequired">): string {
	return createHash("sha256").update(canonical(approvalMaterial(goal))).digest("hex");
}

export function isApprovalCurrent(goal: GoalContract): boolean {
	return goal.status !== "draft" && !!goal.approvedHash && goal.approvedHash === objectiveHash(goal);
}
