// ABOUTME: Tests the session-scoped adaptive verifier retry cap.

import { describe, expect, it } from "vitest";
import {
	createVerifierTuner,
	growVerifierTuner,
	verifierAttemptLimit,
	recordVerifierExhaustion,
	resetVerifierTuner,
	DEFAULT_VERIFIER_ATTEMPTS,
	VERIFIER_ATTEMPTS_MIN,
	VERIFIER_ATTEMPTS_MAX,
} from "../lib/verification-policy.ts";

describe("VerifierTuner adaptive retry cap", () => {
	it("starts at the static default", () => {
		expect(createVerifierTuner()).toEqual({ attempts: DEFAULT_VERIFIER_ATTEMPTS });
	});

	it("grows one step per exhaustion", () => {
		const tuner = createVerifierTuner();
		growVerifierTuner(tuner);
		expect(tuner.attempts).toBe(4);
		growVerifierTuner(tuner);
		expect(tuner.attempts).toBe(5);
	});

	it("clamps at the max cap", () => {
		const tuner = createVerifierTuner();
		for (let i = 0; i < 10; i++) growVerifierTuner(tuner);
		expect(tuner.attempts).toBe(VERIFIER_ATTEMPTS_MAX);
		expect(tuner.attempts).toBe(5);
	});

	it("exposes the process-wide limit and records exhaustion against it", () => {
		resetVerifierTuner();
		expect(verifierAttemptLimit()).toBe(3);
		recordVerifierExhaustion();
		expect(verifierAttemptLimit()).toBe(4);
		for (let i = 0; i < 10; i++) recordVerifierExhaustion();
		expect(verifierAttemptLimit()).toBe(VERIFIER_ATTEMPTS_MAX);
	});

	it("resets the process-wide cap to the default", () => {
		recordVerifierExhaustion();
		resetVerifierTuner();
		expect(verifierAttemptLimit()).toBe(DEFAULT_VERIFIER_ATTEMPTS);
	});

	it("keeps a sane floor constant (never auto-tightens below default)", () => {
		// The cap is grow-only by design: shrinking an unused cap has no upside.
		expect(VERIFIER_ATTEMPTS_MIN).toBe(2);
		expect(DEFAULT_VERIFIER_ATTEMPTS).toBeGreaterThan(VERIFIER_ATTEMPTS_MIN);
	});
});