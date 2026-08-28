// ABOUTME: Tests for context budget pure functions — level thresholds and error detection.
// ABOUTME: Covers contextBudgetLevel thresholds and isContextLossError pattern matching.

import { describe, it, expect } from "vitest";
import { contextBudgetLevel, isContextLossError, subagentContextBudget } from "../lib/context-budget.ts";

describe("contextBudgetLevel", () => {
	it("should return 'ok' below 80%", () => {
		expect(contextBudgetLevel(0)).toBe("ok");
		expect(contextBudgetLevel(50)).toBe("ok");
		expect(contextBudgetLevel(79)).toBe("ok");
	});

	it("should return 'warn' at 80-89%", () => {
		expect(contextBudgetLevel(80)).toBe("warn");
		expect(contextBudgetLevel(85)).toBe("warn");
		expect(contextBudgetLevel(89)).toBe("warn");
	});

	it("should return 'critical' at 90% and above", () => {
		expect(contextBudgetLevel(90)).toBe("critical");
		expect(contextBudgetLevel(95)).toBe("critical");
		expect(contextBudgetLevel(100)).toBe("critical");
	});
});

describe("isContextLossError", () => {
	it("should match the specific API error pattern", () => {
		expect(isContextLossError(
			"Error: unexpected tool_use_id found in tool_result blocks"
		)).toBe(true);
	});

	it("should match when embedded in longer stderr", () => {
		const stderr = "API error 400: unexpected tool_use_id found in tool_result blocks\nStack trace...";
		expect(isContextLossError(stderr)).toBe(true);
	});

	it("should reject unrelated errors", () => {
		expect(isContextLossError("Connection refused")).toBe(false);
		expect(isContextLossError("")).toBe(false);
		expect(isContextLossError("rate limit exceeded")).toBe(false);
	});
});


describe("subagentContextBudget", () => {
	it("reduces batch size and result budget as context fills", () => {
		expect(subagentContextBudget(69, 5)).toEqual({ maxAgents: 5, resultChars: 3500 });
		expect(subagentContextBudget(70, 5)).toEqual({ maxAgents: 3, resultChars: 2800 });
		expect(subagentContextBudget(80, 5)).toEqual({ maxAgents: 2, resultChars: 2000 });
		expect(subagentContextBudget(90, 5)).toEqual({ maxAgents: 0, resultChars: 1200 });
	});

	it("keeps normal behavior when usage is unavailable", () => {
		expect(subagentContextBudget(undefined, 2)).toEqual({ maxAgents: 2, resultChars: 3500 });
	});
});
