// ABOUTME: Bounded verifier retry policy shared by PLAN, TEAM, and PIPELINE.
// ABOUTME: Separates actionable FAIL retries from human-required BLOCKED outcomes.

export const DEFAULT_VERIFIER_ATTEMPTS = 3;

export type VerifierAction = "retry" | "escalate" | "complete";

export function verifierAction(status: "PASS" | "FAIL" | "BLOCKED", attempt: number, maxAttempts = DEFAULT_VERIFIER_ATTEMPTS, hasActionableFix = true): VerifierAction {
  if (status === "PASS") return "complete";
  if (status === "BLOCKED" || attempt >= maxAttempts || !hasActionableFix) return "escalate";
  return "retry";
}
