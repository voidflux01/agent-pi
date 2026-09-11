// ABOUTME: Bounded verifier retry policy shared by PLAN, TEAM, and PIPELINE.
// ABOUTME: Separates actionable FAIL retries from human-required BLOCKED outcomes.

export const DEFAULT_VERIFIER_ATTEMPTS = 3;
export const VERIFIER_ATTEMPTS_MIN = 2;
export const VERIFIER_ATTEMPTS_MAX = 5;

/** Session-scoped adaptive retry cap. */
export interface VerifierTuner {
	attempts: number;
}

export function createVerifierTuner(): VerifierTuner {
	return { attempts: DEFAULT_VERIFIER_ATTEMPTS };
}

/**
 * A retry cap only grows on evidence of insufficiency: shrinking an unused cap
 * costs nothing saved and risks premature BLOCKED on the next genuinely hard
 * campaign, so it is never tightened automatically.
 */
export function growVerifierTuner(t: VerifierTuner): void {
	t.attempts = Math.min(VERIFIER_ATTEMPTS_MAX, t.attempts + 1);
}

// Process-wide active cap. The mode cycler owns its session lifecycle; the
// verifier call sites read it at each campaign start and report exhaustion.
let activeVerifierTuner: VerifierTuner = createVerifierTuner();

export function verifierAttemptLimit(): number {
	return activeVerifierTuner.attempts;
}

/** One budget exhaustion (a campaign burned every round without converging) → the next campaigns get one more round. */
export function recordVerifierExhaustion(): void {
	growVerifierTuner(activeVerifierTuner);
}

export function resetVerifierTuner(): void {
	activeVerifierTuner = createVerifierTuner();
}