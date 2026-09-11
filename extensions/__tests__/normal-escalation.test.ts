// ABOUTME: Tests the NORMAL runtime guard that escalates stalled reconnaissance to SCOUT.

import { describe, expect, it } from "vitest";
import {
	createNormalEscalationState,
	createNormalTuner,
	hardenTuner,
	isNormalReconCall,
	isScoutDispatch,
	normalEscalationReason,
	reconEscalationAdvisory,
	NORMAL_RECON_LIMIT,
	NORMAL_RECON_BLOCK_LIMIT,
	recordNormalToolCall,
	resetNormalEscalation,
	softenTuner,
	stallTuner,
} from "../lib/normal-escalation.ts";
import { classifyTool } from "../lib/tool-classification.ts";

describe("NORMAL progressive escalation", () => {
	it("allows ordinary reconnaissance below the limit", () => {
		const state = createNormalEscalationState();
		for (let i = 0; i < NORMAL_RECON_LIMIT - 1; i++) {
			expect(recordNormalToolCall(state, createNormalTuner(), "grep", { query: `term-${i}` })).toMatchObject({ block: false, count: i + 1 });
		}
	});

	it("allows a new target after the soft threshold and advises once", () => {
		const state = createNormalEscalationState();
		for (let i = 0; i < NORMAL_RECON_LIMIT - 1; i++) recordNormalToolCall(state, createNormalTuner(), "read", { path: `file-${i}.ts` });
		const result = recordNormalToolCall(state, createNormalTuner(), "find", { path: "new-area" });
		expect(result).toMatchObject({ block: false, count: NORMAL_RECON_LIMIT, advisory: true });
		expect(reconEscalationAdvisory("NORMAL", result.count)).toContain("scout");
		expect(recordNormalToolCall(state, createNormalTuner(), "find", { path: "another-area" }).advisory).toBe(false);
	});

	it("blocks a long consecutive reconnaissance run at the hard limit", () => {
		const state = createNormalEscalationState();
		for (let i = 0; i < NORMAL_RECON_BLOCK_LIMIT - 1; i++) recordNormalToolCall(state, createNormalTuner(), "read", { path: `file-${i}.ts` });
		const result = recordNormalToolCall(state, createNormalTuner(), "read", { path: "last.ts" });
		expect(result).toMatchObject({ block: true, count: NORMAL_RECON_BLOCK_LIMIT });
		expect(normalEscalationReason(result.count)).toContain("consecutive");
	});

	it("blocks on call count, not target identity", () => {
		const state = createNormalEscalationState();
		for (let i = 0; i < NORMAL_RECON_BLOCK_LIMIT - 1; i++) recordNormalToolCall(state, createNormalTuner(), "read", { path: `file-${i}.ts` });
		// A brand-new target still blocks once the consecutive ceiling is reached.
		expect(recordNormalToolCall(state, createNormalTuner(), "find", { path: "brand-new-area" })).toMatchObject({ block: true });
	});

	it("resets after a non-recon action so simple work stays frictionless", () => {
		const state = createNormalEscalationState();
		recordNormalToolCall(state, createNormalTuner(), "read");
		recordNormalToolCall(state, createNormalTuner(), "read");
		expect(recordNormalToolCall(state, createNormalTuner(), "bash")).toMatchObject({ block: false, count: 0 });
		expect(recordNormalToolCall(state, createNormalTuner(), "read")).toMatchObject({ block: false, count: 1 });
	});

	it("counts read-only bash exploration but resets for tests and writes", () => {
		expect(isNormalReconCall("bash", { command: "rg -n scout extensions" })).toBe(true);
		expect(isNormalReconCall("bash", { command: "ffgrep scout extensions" })).toBe(true);
		expect(isNormalReconCall("bash", { command: "cd src && find . -type f" })).toBe(true);
		expect(isNormalReconCall("bash", { command: "bun test" })).toBe(false);
		expect(isNormalReconCall("bash", { command: "sed -i 's/a/b/' file.ts" })).toBe(false);

		const state = createNormalEscalationState();
		for (let i = 0; i < NORMAL_RECON_LIMIT - 1; i++) recordNormalToolCall(state, createNormalTuner(), "bash", { command: "rg -n TODO ." });
		expect(recordNormalToolCall(state, createNormalTuner(), "bash", { command: "bun test" })).toMatchObject({ block: false, count: 0 });
	});

	it("counts direct ffgrep exploration", () => {
		const state = createNormalEscalationState();
		expect(recordNormalToolCall(state, createNormalTuner(), "ffgrep")).toMatchObject({ block: false, count: 1 });
	});

	it("uses the shared classification for tool intent", () => {
		expect(classifyTool("ffgrep")).toMatchObject({ intent: "recon", readOnly: true });
		expect(classifyTool("mcp__docs__search")).toMatchObject({ intent: "network", readOnly: false });
		expect(classifyTool("write")).toMatchObject({ intent: "write", readOnly: false });
	});

	it("can be reset on a new session or mode transition", () => {
		const state = createNormalEscalationState();
		recordNormalToolCall(state, createNormalTuner(), "read");
		resetNormalEscalation(state);
		expect(recordNormalToolCall(state, createNormalTuner(), "read")).toMatchObject({ block: false, count: 1 });
	});
});

describe("NormalTuner adaptive feedback", () => {
	it("starts at the static defaults", () => {
		expect(createNormalTuner()).toEqual({ soft: NORMAL_RECON_LIMIT, block: NORMAL_RECON_BLOCK_LIMIT });
	});

	it("softens after the model picks a scout", () => {
		const tuner = createNormalTuner();
		softenTuner(tuner);
		expect(tuner.soft).toBe(3);
		expect(tuner.block).toBe(8);
		// Floor at 2.
		for (let i = 0; i < 5; i++) softenTuner(tuner);
		expect(tuner.soft).toBe(2);
	});

	it("hardens after the model acts without a scout, never above the block limit", () => {
		const tuner = createNormalTuner();
		hardenTuner(tuner);
		expect(tuner.soft).toBe(5);
		for (let i = 0; i < 6; i++) hardenTuner(tuner);
		expect(tuner.soft).toBe(8);
		expect(tuner.soft).toBeLessThanOrEqual(tuner.block);
	});

	it("stall lowers both thresholds with safe floors", () => {
		const tuner = createNormalTuner();
		stallTuner(tuner);
		expect(tuner.soft).toBe(3);
		expect(tuner.block).toBe(7);

		const floored = { soft: 2, block: 4 };
		stallTuner(floored);
		expect(floored.soft).toBe(2);
		expect(floored.block).toBe(4);
	});

	it("keeps the soft threshold at or below the block threshold", () => {
		const tuner = { soft: 8, block: 4 };
		hardenTuner(tuner);
		expect(tuner).toEqual({ soft: 4, block: 4 });

		const stalled = { soft: 8, block: 5 };
		stallTuner(stalled);
		expect(stalled).toEqual({ soft: 3, block: 4 });
	});

	it("classifies scout dispatch and ignores other agents", () => {
		expect(isScoutDispatch("subagent_create", { name: "scout", task: "map" })).toBe(true);
		expect(isScoutDispatch("subagent_create", { name: "researcher", task: "web" })).toBe(false);
		expect(isScoutDispatch("subagent_create_batch", { agents: [{ name: "scout" }, { name: "researcher" }] })).toBe(true);
		expect(isScoutDispatch("bash", { command: "rg scout" })).toBe(false);
	});
});