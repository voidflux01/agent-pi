// ABOUTME: Tests that chains inherit their launching model unless routing is explicit.
// ABOUTME: Protects provider consent while retaining a fallback for missing runtime metadata.

import { describe, expect, it } from "vitest";
import { providerModelString, resolveInheritedModel } from "../lib/model-inheritance.ts";

describe("chain model inheritance", () => {
	it("formats the parent provider/model identifier", () => {
		expect(providerModelString({ provider: "openai-codex", id: "gpt-5.4" }))
			.toBe("openai-codex/gpt-5.4");
	});

	it("uses an explicit agent model before the launching model", () => {
		expect(resolveInheritedModel(
			"anthropic/claude-opus-4-6",
			"openai-codex/gpt-5.4",
			"legacy/default",
		)).toBe("anthropic/claude-opus-4-6");
	});

	it("inherits the model that launched Pi by default", () => {
		expect(resolveInheritedModel("", "x-ai/grok-4.1-fast", "legacy/default"))
			.toBe("x-ai/grok-4.1-fast");
	});

	it("uses the legacy fallback when Pi exposes no parent model", () => {
		expect(resolveInheritedModel(undefined, "", "anthropic/claude-haiku-4-5"))
			.toBe("anthropic/claude-haiku-4-5");
	});
});
