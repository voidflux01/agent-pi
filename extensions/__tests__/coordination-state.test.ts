// ABOUTME: Contract tests for the typed coordination state bus.
// ABOUTME: Verifies mode, active workflows, approvals, and mode-change listeners.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { coordinationState, setActiveChain, setActivePipeline, setCoordinationMode, onCoordinationModeChange, verificationScope, bumpVerifierAttempt, getVerifierAttempt, setEvalGate, getEvalGate, setVerifierReceipt } from "../lib/coordination-state.ts";
import type { VerifierReceipt } from "../lib/verifier-runtime.ts";

function resetState(): void {
	setCoordinationMode("NORMAL");
	setActiveChain(null);
	setActivePipeline(null);
	coordinationState().planApproved = false;
	coordinationState().specApproved = false;
	coordinationState().executionContract = undefined;
	coordinationState().verificationSessions = Object.create(null);
}

beforeEach(resetState);

describe("coordination state bus", () => {
	it("stores mode and active workflow state in one typed object", () => {
		setCoordinationMode("PLAN");
		setActiveChain("chain-1");
		setActivePipeline("pipeline-1");
		expect(coordinationState()).toMatchObject({ mode: "PLAN", activeChain: "chain-1", activePipeline: "pipeline-1" });
	});

	it("passes the live UI ctx to mode-change listeners", () => {
		const ui = { setWidget: vi.fn() };
		const listener = vi.fn();
		const stop = onCoordinationModeChange(listener);
		setCoordinationMode("CHAIN", { ui });
		expect(listener).toHaveBeenCalledWith("CHAIN", "NORMAL", { ui });
		stop();
	});

	it("keeps attempts and eval gates isolated by cwd and contract", () => {
		const first = verificationScope("/tmp/one", "a");
		const second = verificationScope("/tmp/two", "a");
		bumpVerifierAttempt(first);
		bumpVerifierAttempt(first);
		bumpVerifierAttempt(second);
		setEvalGate({ ok: true, reason: "first" }, first);
		expect(getVerifierAttempt(first)).toBe(2);
		expect(getVerifierAttempt(second)).toBe(1);
		expect(getEvalGate(first)?.reason).toBe("first");
		expect(getEvalGate(second)).toBeUndefined();
	});

	it("a PASS receipt resets the attempt budget so a later edit can re-verify", () => {
		const scope = verificationScope("/tmp/one", "a");
		bumpVerifierAttempt(scope);
		bumpVerifierAttempt(scope);
		bumpVerifierAttempt(scope); // failure ceiling spent
		expect(getVerifierAttempt(scope)).toBe(3);
		setVerifierReceipt({ status: "PASS", contractFingerprint: "a", workspaceManifestHash: "h", results: [], attempt: 3, version: 3, createdAt: new Date().toISOString() } as VerifierReceipt, scope);
		expect(getVerifierAttempt(scope)).toBe(0);
		// A FAIL receipt leaves the budget alone — only PASS closes it.
		setVerifierReceipt({ status: "FAIL", contractFingerprint: "a", workspaceManifestHash: "h", results: [], attempt: 1, version: 3, createdAt: new Date().toISOString() } as VerifierReceipt, scope);
		expect(getVerifierAttempt(scope)).toBe(0);
		bumpVerifierAttempt(scope);
		expect(getVerifierAttempt(scope)).toBe(1);
	});
});
