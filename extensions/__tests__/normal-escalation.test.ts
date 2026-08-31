// ABOUTME: Tests the NORMAL runtime guard that escalates stalled reconnaissance to SCOUT.

import { describe, expect, it } from "vitest";
import {
	createNormalEscalationState,
	isNormalReconCall,
	normalEscalationReason,
	NORMAL_RECON_LIMIT,
	recordNormalToolCall,
	resetNormalEscalation,
} from "../lib/normal-escalation.ts";

describe("NORMAL progressive escalation", () => {
	it("allows ordinary reconnaissance below the limit", () => {
		const state = createNormalEscalationState();
		for (let i = 0; i < NORMAL_RECON_LIMIT - 1; i++) {
			expect(recordNormalToolCall(state, "grep")).toEqual({ block: false, count: i + 1 });
		}
	});

	it("blocks the recon loop at the limit", () => {
		const state = createNormalEscalationState();
		for (let i = 0; i < NORMAL_RECON_LIMIT - 1; i++) recordNormalToolCall(state, "read");
		expect(recordNormalToolCall(state, "find")).toEqual({ block: true, count: NORMAL_RECON_LIMIT });
		expect(normalEscalationReason(NORMAL_RECON_LIMIT)).toContain('name: "scout"');
	});

	it("resets after a non-recon action so simple work stays frictionless", () => {
		const state = createNormalEscalationState();
		recordNormalToolCall(state, "read");
		recordNormalToolCall(state, "read");
		expect(recordNormalToolCall(state, "bash")).toEqual({ block: false, count: 0 });
		expect(recordNormalToolCall(state, "read")).toEqual({ block: false, count: 1 });
	});

	it("counts read-only bash exploration but resets for tests and writes", () => {
		expect(isNormalReconCall("bash", { command: "rg -n scout extensions" })).toBe(true);
		expect(isNormalReconCall("bash", { command: "cd src && find . -type f" })).toBe(true);
		expect(isNormalReconCall("bash", { command: "bun test" })).toBe(false);
		expect(isNormalReconCall("bash", { command: "sed -i 's/a/b/' file.ts" })).toBe(false);

		const state = createNormalEscalationState();
		for (let i = 0; i < NORMAL_RECON_LIMIT - 1; i++) recordNormalToolCall(state, "bash", { command: "rg -n TODO ." });
		expect(recordNormalToolCall(state, "bash", { command: "bun test" })).toEqual({ block: false, count: 0 });
	});

	it("can be reset on a new session or mode transition", () => {
		const state = createNormalEscalationState();
		recordNormalToolCall(state, "read");
		resetNormalEscalation(state);
		expect(recordNormalToolCall(state, "read")).toEqual({ block: false, count: 1 });
	});
});
