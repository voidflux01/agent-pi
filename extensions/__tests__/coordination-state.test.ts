// ABOUTME: Contract tests for the typed coordination state bus.
// ABOUTME: Verifies mode, active workflows, approvals, and mode-change listeners.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { coordinationState, setActiveChain, setActivePipeline, setCoordinationMode, onCoordinationModeChange } from "../lib/coordination-state.ts";

function resetState(): void {
	setCoordinationMode("NORMAL");
	setActiveChain(null);
	setActivePipeline(null);
	coordinationState().planApproved = false;
	coordinationState().specApproved = false;
	coordinationState().executionContract = undefined;
	coordinationState().verifierReceipt = undefined;
	coordinationState().verifierAttempt = 0;
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
});
