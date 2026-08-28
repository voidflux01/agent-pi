// ABOUTME: Covers provider payload shapes used to swap the mode system prompt mid-run.
import { describe, expect, it } from "vitest";
import { rewritePayloadSystemPrompt } from "../lib/rewrite-system-prompt.ts";

describe("rewritePayloadSystemPrompt", () => {
	it("replaces an Anthropic string system field", () => {
		const { payload, applied } = rewritePayloadSystemPrompt(
			{ model: "x", system: "old", messages: [] },
			"PLAN",
		);
		expect(applied).toBe(true);
		expect(payload).toEqual({ model: "x", system: "PLAN", messages: [] });
	});

	it("replaces Anthropic system blocks", () => {
		const { payload, applied } = rewritePayloadSystemPrompt(
			{ system: [{ type: "text", text: "old", cache: true }] },
			"PLAN",
		);
		expect(applied).toBe(true);
		expect((payload as any).system[0]).toEqual({ type: "text", text: "PLAN", cache: true });
	});

	it("replaces an OpenAI-style system message", () => {
		const { payload, applied } = rewritePayloadSystemPrompt(
			{ messages: [{ role: "system", content: "old" }, { role: "user", content: "hi" }] },
			"PLAN",
		);
		expect(applied).toBe(true);
		expect((payload as any).messages[0].content).toBe("PLAN");
		expect((payload as any).messages[1].content).toBe("hi");
	});

	it("replaces a Responses API developer/system item", () => {
		const { payload, applied } = rewritePayloadSystemPrompt(
			{ input: [{ role: "developer", content: "old" }] },
			"PLAN",
		);
		expect(applied).toBe(true);
		expect((payload as any).input[0].content).toBe("PLAN");
	});

	it("rewrites a nested body wrapper", () => {
		const { payload, applied } = rewritePayloadSystemPrompt(
			{ body: { messages: [{ role: "system", content: "old" }] } },
			"PLAN",
		);
		expect(applied).toBe(true);
		expect((payload as any).body.messages[0].content).toBe("PLAN");
	});

	it("leaves unknown payloads unchanged", () => {
		const original = { foo: 1 };
		const { payload, applied } = rewritePayloadSystemPrompt(original, "PLAN");
		expect(applied).toBe(false);
		expect(payload).toBe(original);
	});
});
