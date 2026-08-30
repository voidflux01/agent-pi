// ABOUTME: Contract tests for the typed coordination state bus.
// ABOUTME: Verifies one state source for mode, Commander readiness, and active workflows.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReadyGate } from "../lib/commander-ready.ts";
import {
	addCommanderReadyCallback,
	commanderAvailable,
	commanderClient,
	commanderGate,
	commanderState,
	coordinationState,
	drainCommanderReadyCallbacks,
	resolveCommanderGate,
	resetCommanderGate,
	setActiveChain,
	setActivePipeline,
	setCommanderClient,
	setCommanderGate,
	setCommanderState,
	setCoordinationMode,
	onCoordinationModeChange,
} from "../lib/coordination-state.ts";

function resetState(): void {
	setCommanderGate(createReadyGate());
	setCommanderClient(undefined);
	setCommanderState("pending");
	setCoordinationMode("NORMAL");
	setActiveChain(null);
	setActivePipeline(null);
	coordinationState().planApproved = false;
	coordinationState().specApproved = false;
	coordinationState().executionContract = undefined;
	coordinationState().verifierReceipt = undefined;
	coordinationState().verifierAttempt = 0;
	drainCommanderReadyCallbacks();
}

// Keep each test independent because the bus intentionally lives on globalThis.
beforeEach(resetState);

describe("coordination state bus", () => {
	it("stores mode and active workflow state in one typed object", () => {
		setCoordinationMode("PLAN");
		setActiveChain("chain-1");
		setActivePipeline("pipeline-1");

		expect(coordinationState()).toMatchObject({
			mode: "PLAN",
			activeChain: "chain-1",
			activePipeline: "pipeline-1",
		});
	});

	it("keeps Commander state, gate, and client synchronized", () => {
		const client = { callTool: vi.fn() };
		setCommanderClient(client);
		setCommanderState("available");

		expect(commanderAvailable()).toBe(true);
		expect(commanderClient()).toBe(client);
		expect(commanderState().state).toBe("available");
		expect(commanderGate()?.state).toBe("available");
	});

	it("resolves queued work without changing the queue contract", async () => {
		const client = { callTool: vi.fn() };
		const fn = vi.fn().mockResolvedValue(undefined);
		setCommanderClient(client);
		commanderGate()!.queue.push({ fn, label: "test" });

		const queued = resolveCommanderGate(true);
		expect(queued).toHaveLength(1);
		expect(commanderAvailable()).toBe(true);
		expect(commanderGate()?.queue).toHaveLength(0);
		await queued[0].fn(client);
		expect(fn).toHaveBeenCalledWith(client);
	});

	it("resets a gate to pending so later work queues", () => {
		setCommanderState("available");
		resetCommanderGate();

		expect(commanderState().state).toBe("pending");
		expect(commanderGate()?.state).toBe("pending");
		expect(commanderAvailable()).toBe(false);
	});

	it("passes the live UI ctx to mode-change listeners", () => {
		const ui = { setWidget: vi.fn() };
		const listener = vi.fn();
		const stop = onCoordinationModeChange(listener);
		setCoordinationMode("CHAIN", { ui });
		expect(listener).toHaveBeenCalledWith("CHAIN", "NORMAL", { ui });
		stop();
		setCoordinationMode("NORMAL");
	});

	it("drains ready callbacks exactly once", () => {
		const callback = vi.fn();
		addCommanderReadyCallback(callback);

		expect(drainCommanderReadyCallbacks()).toEqual([callback]);
		expect(drainCommanderReadyCallbacks()).toEqual([]);
	});
});
