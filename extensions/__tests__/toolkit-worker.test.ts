// ABOUTME: Tests toolkit CLI worker helpers and routing behavior.

import { describe, it, expect } from "vitest";
import { 
	isToolkitCliAgent,
	resolveToolkitWorkerModel,
	TOOLKIT_WORKER_MODEL,
	getToolkitWorkerArgs,
	parseToolkitResult,
} from "../lib/toolkit-cli.ts";
import { resolveAgentModelString, type AgentModelsConfig } from "../lib/agent-defs.ts";

describe("toolkit CLI agent detection", () => {
	it("detects toolkit agents", () => {
		expect(isToolkitCliAgent("codex-agent")).toBe(true);
		expect(isToolkitCliAgent("CURSOR-AGENT")).toBe(true);
		expect(isToolkitCliAgent("builder")).toBe(false);
	});
});

describe("toolkit worker model resolution", () => {
	it("forces toolkit agents onto the shared worker model", () => {
		expect(resolveToolkitWorkerModel("codex-agent", "openai/gpt-4o")).toBe(TOOLKIT_WORKER_MODEL);
	});

	it("preserves non-toolkit fallback models", () => {
		expect(resolveToolkitWorkerModel("reviewer", "anthropic/claude-opus-4-6")).toBe("anthropic/claude-opus-4-6");
	});
});

describe("toolkit worker args", () => {
	it("builds pi args with the shared worker model", () => {
		const args = getToolkitWorkerArgs({
			name: "codex-agent",
			tools: "bash,read",
			systemPrompt: "Use Codex CLI",
		}, {
			task: "Analyze this project",
			sessionFile: "/tmp/session.jsonl",
		});

		expect(args).toContain("--model");
		expect(args).toContain(TOOLKIT_WORKER_MODEL);
		expect(args).toContain("--tools");
		expect(args).toContain("bash,read");
		expect(args).toContain("Analyze this project");
	});
});

describe("agent model config split", () => {
	const config: AgentModelsConfig = {
		default: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
		agents: {
			reviewer: { provider: "anthropic", model: "claude-opus-4-6" },
			"codex-agent": { provider: "openai-codex", model: "gpt-5.4" },
		},
	};

	it("still resolves normal agents from standard config", () => {
		expect(resolveAgentModelString("reviewer", config)).toBe("anthropic/claude-opus-4-6");
	});

	it("overrides toolkit agents to the shared worker model even if config differs", () => {
		expect(resolveAgentModelString("codex-agent", config)).toBe(TOOLKIT_WORKER_MODEL);
	});
});


describe("external runtime result parsing", () => {
	it("parses opencode JSON events into text and usage", () => {
		const raw = [
			'{"type":"step-start"}',
			'{"type":"text","part":{"type":"text","text":"pon"}}',
			'{"type":"text","part":{"type":"text","text":"g"}}',
			'{"type":"step_finish","part":{"reason":"stop","tokens":{"total":10,"input":9,"output":1,"cache":{"read":4,"write":0}},"cost":0.5}}',
		].join("\n");
		const { text, usage } = parseToolkitResult("opencode-agent", raw);
		expect(text).toBe("pong");
		expect(usage).toEqual({ input: 9, output: 1, cacheRead: 4, cacheWrite: 0, totalTokens: 10, costUsd: 0.5 });
	});

	it("surfaces opencode stream errors as result text", () => {
		const raw = '{"type":"error","error":{"name":"UnknownError","data":{"message":"boom"}}}';
		const { text } = parseToolkitResult("opencode-agent", raw);
		expect(text).toContain("[opencode error] boom");
	});

	it("parses prime-agent assistant message_end only (ignores echoed user message)", () => {
		const raw = [
			'{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"Reply with: pong"}],"usage":{"totalTokens":5}}}',
			'{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hm"},{"type":"text","text":"pong"}],"usage":{"input":13,"output":18,"cacheRead":7900,"cacheWrite":0,"totalTokens":7967,"cost":{"total":0.000827}}}}',
		].join("\n");
		const { text, usage } = parseToolkitResult("prime-agent", raw);
		expect(text).toBe("pong");
		expect(usage?.totalTokens).toBe(7967);
		expect(usage?.costUsd).toBeCloseTo(0.000827, 8);
	});

	it("returns empty for plain-text CLIs (no structured output)", () => {
		const { text, usage } = parseToolkitResult("cursor-agent", "hello\nworld\n");
		expect(text).toBe("");
		expect(usage).toBeUndefined();
	});
});
