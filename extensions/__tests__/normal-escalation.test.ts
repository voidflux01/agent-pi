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
import { classifyTool } from "../lib/tool-classification.ts";

describe("NORMAL progressive escalation", () => {
	it("allows ordinary reconnaissance below the limit", () => {
		const state = createNormalEscalationState();
		for (let i = 0; i < NORMAL_RECON_LIMIT - 1; i++) {
			expect(recordNormalToolCall(state, "grep", { query: `term-${i}` })).toMatchObject({ block: false, count: i + 1 });
		}
	});

	it("allows a new target after the soft threshold and advises once", () => {
		const state = createNormalEscalationState();
		for (let i = 0; i < NORMAL_RECON_LIMIT - 1; i++) recordNormalToolCall(state, "read", { path: `file-${i}.ts` });
		const result = recordNormalToolCall(state, "find", { path: "new-area" });
		expect(result).toMatchObject({ block: false, count: NORMAL_RECON_LIMIT, advisory: true });
		expect(recordNormalToolCall(state, "find", { path: "another-area" }).advisory).toBe(false);
	});

	it("blocks a repeated target after the soft threshold", () => {
		const state = createNormalEscalationState();
		for (let i = 0; i < NORMAL_RECON_LIMIT - 1; i++) recordNormalToolCall(state, "read", { path: `file-${i}.ts` });
		recordNormalToolCall(state, "find", { path: "same-area" });
		const result = recordNormalToolCall(state, "find", { path: "same-area" });
		expect(result).toMatchObject({ block: true, count: NORMAL_RECON_LIMIT + 1 });
		expect(normalEscalationReason(result.count)).toContain("same reconnaissance target");
	});

	it("normalizes equivalent targets for fingerprinting", () => {
		const state = createNormalEscalationState();
		for (let i = 0; i < NORMAL_RECON_LIMIT - 1; i++) recordNormalToolCall(state, "bash", { command: `rg   -n   TODO   src/${i}` });
		recordNormalToolCall(state, "bash", { command: "rg -n TODO src/shared" });
		const result = recordNormalToolCall(state, "bash", { command: "  rg   -n TODO   src/shared  " });
		expect(result.block).toBe(true);
	});

	it("resets after a non-recon action so simple work stays frictionless", () => {
		const state = createNormalEscalationState();
		recordNormalToolCall(state, "read");
		recordNormalToolCall(state, "read");
		expect(recordNormalToolCall(state, "bash")).toMatchObject({ block: false, count: 0 });
		expect(recordNormalToolCall(state, "read")).toMatchObject({ block: false, count: 1 });
	});

	it("counts read-only bash exploration but resets for tests and writes", () => {
		expect(isNormalReconCall("bash", { command: "rg -n scout extensions" })).toBe(true);
		expect(isNormalReconCall("bash", { command: "ffgrep scout extensions" })).toBe(true);
		expect(isNormalReconCall("bash", { command: "cd src && find . -type f" })).toBe(true);
		expect(isNormalReconCall("bash", { command: "bun test" })).toBe(false);
		expect(isNormalReconCall("bash", { command: "sed -i 's/a/b/' file.ts" })).toBe(false);

		const state = createNormalEscalationState();
		for (let i = 0; i < NORMAL_RECON_LIMIT - 1; i++) recordNormalToolCall(state, "bash", { command: "rg -n TODO ." });
		expect(recordNormalToolCall(state, "bash", { command: "bun test" })).toMatchObject({ block: false, count: 0 });
	});

	it("counts direct ffgrep exploration", () => {
		const state = createNormalEscalationState();
		expect(recordNormalToolCall(state, "ffgrep")).toMatchObject({ block: false, count: 1 });
	});

	it("uses the shared classification for tool intent", () => {
		expect(classifyTool("ffgrep")).toMatchObject({ intent: "recon", readOnly: true });
		expect(classifyTool("mcp__docs__search")).toMatchObject({ intent: "network", readOnly: false });
		expect(classifyTool("write")).toMatchObject({ intent: "write", readOnly: false });
	});

	it("can be reset on a new session or mode transition", () => {
		const state = createNormalEscalationState();
		recordNormalToolCall(state, "read");
		resetNormalEscalation(state);
		expect(recordNormalToolCall(state, "read")).toMatchObject({ block: false, count: 1 });
	});
});
