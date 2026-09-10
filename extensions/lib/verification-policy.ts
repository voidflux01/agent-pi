// ABOUTME: Bounded verifier retry policy shared by PLAN, TEAM, and PIPELINE.
// ABOUTME: Separates actionable FAIL retries from human-required BLOCKED outcomes.

export const DEFAULT_VERIFIER_ATTEMPTS = 3;

export type VerifierAction = "retry" | "escalate" | "complete";

