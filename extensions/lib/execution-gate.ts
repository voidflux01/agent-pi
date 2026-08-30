// ABOUTME: Completion gate policy shared by PLAN, TEAM, and PIPELINE.
// ABOUTME: Keeps verification policy separate from UI and orchestration implementations.

import type { GoalContract } from "./execution-contract.ts";
import { objectiveHash } from "./execution-contract.ts";
import type { VerifierReceipt } from "./verifier-runtime.ts";
import { canComplete } from "./verifier-runtime.ts";

export type ExecutionMode = "NORMAL" | "PLAN" | "SPEC" | "TEAM" | "CHAIN" | "PIPELINE";

export function verificationRequired(mode: ExecutionMode | string | undefined, hasWrites: boolean): boolean {
  const normalized = (mode || "NORMAL").toUpperCase();
  return hasWrites && ["PLAN", "SPEC", "TEAM", "PIPELINE", "CHAIN"].includes(normalized);
}

export function completionDecision(input: {
  mode: ExecutionMode | string | undefined;
  hasWrites: boolean;
  goal?: GoalContract;
  receipt?: VerifierReceipt;
  workspaceHash?: string;
}): { allowed: boolean; reason?: string } {
  if (!verificationRequired(input.mode, input.hasWrites)) return { allowed: true };
  if (!input.goal || !input.receipt) return { allowed: false, reason: "This execution requires an independent verifier receipt before completion." };
  if (!canComplete(input.receipt, objectiveHash(input.goal), input.workspaceHash)) return { allowed: false, reason: "The verifier receipt is missing, failed, or bound to a different objective." };
  return { allowed: true };
}
