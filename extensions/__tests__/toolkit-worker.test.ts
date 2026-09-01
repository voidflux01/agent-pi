// ABOUTME: Tests toolkit CLI worker helpers and routing behavior.

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { 
	isToolkitCliAgent,
	resolveToolkitWorkerModel,
	TOOLKIT_WORKER_MODEL,
	getToolkitWorkerArgs,
	parseToolkitResult,
	toolkitRuntimeName,
	toolkitVisibleCommandLine,
	spawnToolkitWorker,
	MAX_TOOLKIT_OUTPUT_CHARS,
	toolkitBareMode,
	toolkitHerdrAgent,
	toolkitHerdrLabel,
	toolkitHerdrAutoCloseMs,
	getToolkitTuiArgv,
	toolkitHasInteractiveTui,
} from "../lib/toolkit-cli.ts";
import { resolveAgentModelString, scanToolkitAgentDefs, type AgentModelsConfig } from "../lib/agent-defs.ts";
import { explicitDispatchHandler } from "../lib/dispatch-runtime.ts";

function runExplicit<T>(operation: () => T): T {
	return explicitDispatchHandler("agent-team", operation)();
}

describe("toolkit CLI agent detection", () => {
	it("refuses to spawn outside an explicit dispatch context", async () => {
		const result = await spawnToolkitWorker({
			name: "codex-agent",
			tools: "read",
			systemPrompt: "test",
		}, { task: "must not run" });

		expect(result.exitCode).toBe(126);
		expect(result.output).toContain("explicit tool or slash command");
	});

	it("records a synchronous spawn failure instead of rejecting", async () => {
		const result = await runExplicit(() => spawnToolkitWorker({
			name: "codex-agent", tools: "", systemPrompt: "",
		}, {
			task: "fail to spawn",
			spawnProcess: (() => { throw new Error("spawn denied"); }) as any,
		}));

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("CLI spawn error (codex)");
		expect(result.output).toContain("spawn denied");
	});

	it("retains asynchronous spawn errors in the returned output", async () => {
		const child = new EventEmitter() as EventEmitter & {
			stdout: PassThrough;
			stderr: PassThrough;
		};
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		const resultPromise = runExplicit(() => spawnToolkitWorker({
			name: "codex-agent", tools: "", systemPrompt: "",
		}, {
			task: "async failure",
			spawnProcess: (() => child) as any,
		}));
		child.emit("error", new Error("worker unavailable"));

		await expect(resultPromise).resolves.toMatchObject({ exitCode: 1, output: expect.stringContaining("worker unavailable") });
	});

	it("cancels a headless toolkit worker and terminates its child", async () => {
		const child = new EventEmitter() as EventEmitter & {
			stdout: PassThrough;
			stderr: PassThrough;
			kill: (signal?: NodeJS.Signals | number) => boolean;
		};
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		let signal: NodeJS.Signals | number | undefined;
		child.kill = (nextSignal) => {
			signal = nextSignal;
			child.emit("close", 1);
			return true;
		};
		let cancelled = false;
		const resultPromise = runExplicit(() => spawnToolkitWorker({
			name: "codex-agent", tools: "", systemPrompt: "",
		}, {
			task: "cancel me",
			isCancelled: () => cancelled,
			spawnProcess: (() => child) as any,
		}));
		setTimeout(() => { cancelled = true; }, 70);

		await expect(resultPromise).resolves.toMatchObject({ exitCode: 130 });
		expect(signal).toBe("SIGTERM");
	});

	it("times out a headless toolkit worker and reports a failed result", async () => {
		const child = new EventEmitter() as EventEmitter & {
			stdout: PassThrough;
			stderr: PassThrough;
			kill: (signal?: NodeJS.Signals | number) => boolean;
		};
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		let signal: NodeJS.Signals | number | undefined;
		child.kill = (nextSignal) => {
			signal = nextSignal;
			child.emit("close", 1);
			return true;
		};
		const resultPromise = runExplicit(() => spawnToolkitWorker({
			name: "codex-agent", tools: "", systemPrompt: "",
		}, {
			task: "time out",
			timeoutMs: 20,
			spawnProcess: (() => child) as any,
		}));

		await expect(resultPromise).resolves.toMatchObject({ exitCode: 1, output: expect.stringContaining("timed out") });
		expect(signal).toBe("SIGTERM");
	});

	it("bounds captured toolkit output while retaining both ends", async () => {
		const child = new EventEmitter() as EventEmitter & {
			stdout: PassThrough;
			stderr: PassThrough;
		};
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		const resultPromise = runExplicit(() => spawnToolkitWorker({
			name: "codex-agent", tools: "", systemPrompt: "",
		}, {
			task: "large output",
			spawnProcess: (() => child) as any,
		}));
		const large = "head-" + "x".repeat(MAX_TOOLKIT_OUTPUT_CHARS * 2) + "-tail";
		child.stdout.end(large);
		child.emit("close", 0);

		const result = await resultPromise;
		expect(result.output.length).toBeLessThanOrEqual(MAX_TOOLKIT_OUTPUT_CHARS);
		expect(result.output).toContain("toolkit output truncated");
		expect(result.output.startsWith("head-")).toBe(true);
		expect(result.output.endsWith("-tail")).toBe(true);
	});


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
		expect(args).not.toContain("--no-extensions");
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
	it("parses omp assistant message_end into text and usage", () => {
		const raw = [
			'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"pon"}],"usage":{"input":9}}}',
			'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"g"}],"usage":{"input":9,"output":1,"cacheRead":4,"cacheWrite":0,"totalTokens":10,"cost":{"total":0.5}}}}',
		].join("\n");
		const { text, usage, model } = parseToolkitResult("omp-agent", raw);
		expect(text).toBe("pong");
		expect(usage).toEqual({ input: 9, output: 1, cacheRead: 4, cacheWrite: 0, totalTokens: 10, costUsd: 0.5 });
		expect(model).toBeUndefined();
	});

	it("surfaces omp stream errors as result text", () => {
		const raw = '{"type":"error","error":{"name":"UnknownError","data":{"message":"boom"}}}';
		const { text } = parseToolkitResult("omp-agent", raw);
		expect(text).toContain("[omp-agent error] boom");
	});

	it("records provider/model from assistant message_end", () => {
		const raw = '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"PONG"}],"provider":"opencode-go","model":"deepseek-v4-flash","usage":{"totalTokens":10,"cost":{"total":0.1}}}}';
		const { text, model } = parseToolkitResult("omp-agent", raw);
		expect(text).toBe("PONG");
		expect(model).toBe("opencode-go/deepseek-v4-flash");
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

	it("parses interactive session jsonl when there is no message_end stream", () => {
		const raw = [
			'{"type":"message","message":{"role":"user","content":[{"type":"text","text":"PONG?"}]}}',
			'{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"PONG"}],"provider":"opencode-go","model":"deepseek-v4-flash","usage":{"input":3,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":4,"cost":{"total":0.01}}}}',
		].join("\n");
		const { text, model, usage } = parseToolkitResult("omp-agent", raw);
		expect(text).toBe("PONG");
		expect(model).toBe("opencode-go/deepseek-v4-flash");
		expect(usage?.totalTokens).toBe(4);
	});
});


describe("visible external runtime helpers", () => {
	it("maps toolkit agent names to short runtime labels", () => {
		expect(toolkitRuntimeName("omp-agent")).toBe("omp");
		expect(toolkitRuntimeName("prime-agent")).toBe("prime");
		expect(toolkitRuntimeName("builder")).toBeUndefined();
	});

	it("builds a TUI command line for omp in a herdr pane", () => {
		expect(toolkitHasInteractiveTui("omp-agent")).toBe(true);
		expect(toolkitHasInteractiveTui("cursor-agent")).toBe(false);
		const argv = toolkitVisibleCommandLine(
			"omp-agent", "do it", "/tmp/x", "/tmp/x/out.raw", "omp-sa1", "/tmp/sess", "/ext/herdr-done.ts",
		);
		expect(argv[0]).toBe("bash");
		const script = argv[2];
		expect(script).toContain("exec ");
		expect(script).toContain("omp ");
		expect(script).toContain("--session-dir /tmp/sess");
		expect(script).toContain("-e /ext/herdr-done.ts");
		expect(script).not.toMatch(/(^|\s)-p(\s|$)/);
		expect(script).not.toContain("--mode json");
		expect(script).not.toContain("tee ");
		expect(script).toContain("omp-sa1");
		expect(script).toContain("\\033]0;");
		const tui = getToolkitTuiArgv("omp-agent", "do it", "/tmp/sess", "/ext/herdr-done.ts");
		expect(tui).toContain("--auto-approve");
	});

	it("adds --no-extensions --no-skills only when PI_TOOLKIT_BARE=1", () => {
		expect(toolkitBareMode()).toBe(false);
		const prev = process.env.PI_TOOLKIT_BARE;
		process.env.PI_TOOLKIT_BARE = "1";
		try {
			expect(toolkitBareMode()).toBe(true);
			const script = toolkitVisibleCommandLine("omp-agent", "t", undefined, "/tmp/o.raw", undefined, "/tmp/s", "/e.ts")[2];
			expect(script).toContain("--no-extensions");
			expect(script).toContain("--no-skills");
			const prime = toolkitVisibleCommandLine("prime-agent", "t", undefined, "/tmp/o.raw", undefined, "/tmp/s", "/e.ts")[2];
			expect(prime).toContain("-ne");
			expect(prime).toContain("-ns");
		} finally {
			if (prev === undefined) delete process.env.PI_TOOLKIT_BARE;
			else process.env.PI_TOOLKIT_BARE = prev;
		}
	});

	it("returns empty command for unknown agents (falls back headless)", () => {
		expect(toolkitVisibleCommandLine("mystery-agent", "t", undefined, "/tmp/o.raw")).toEqual([]);
	});

	it("canonicalizes herdr tab labels to omp-agent / prime-agent", () => {
		expect(toolkitHerdrAgent("OMP-AGENT")).toBe("omp-agent");
		expect(toolkitHerdrAgent("prime-agent")).toBe("prime-agent");
		expect(toolkitHerdrLabel("omp-agent", "OMP-AGENT-sa1")).toBe("omp-agent-sa1");
		expect(toolkitHerdrLabel("prime-agent", "prime-agent-sa2")).toBe("prime-agent-sa2");
		expect(toolkitHerdrLabel("omp-agent")).toBe("omp-agent");
	});

	it("lingers then closes by default; keep is opt-in", () => {
		const prev = process.env.PI_HERDR_LINGER_MS;
		try {
			delete process.env.PI_HERDR_LINGER_MS;
			expect(toolkitHerdrAutoCloseMs()).toBe(12_000);
			expect(toolkitHerdrAutoCloseMs("error")).toBe(30_000);
			process.env.PI_HERDR_LINGER_MS = "0";
			expect(toolkitHerdrAutoCloseMs()).toBe(0);
			expect(toolkitHerdrAutoCloseMs("error")).toBe(0);
			process.env.PI_HERDR_LINGER_MS = "15000";
			expect(toolkitHerdrAutoCloseMs()).toBe(15_000);
			expect(toolkitHerdrAutoCloseMs("error")).toBe(30_000);
			process.env.PI_HERDR_LINGER_MS = "60000";
			expect(toolkitHerdrAutoCloseMs()).toBe(60_000);
			expect(toolkitHerdrAutoCloseMs("error")).toBe(60_000);
			process.env.PI_HERDR_LINGER_MS = "keep";
			expect(toolkitHerdrAutoCloseMs()).toBeNull();
			expect(toolkitHerdrAutoCloseMs("error")).toBeNull();
			process.env.PI_HERDR_LINGER_MS = "-1";
			expect(toolkitHerdrAutoCloseMs()).toBeNull();
		} finally {
			if (prev === undefined) delete process.env.PI_HERDR_LINGER_MS;
			else process.env.PI_HERDR_LINGER_MS = prev;
		}
	});
});

describe("builtin toolkit agent defs", () => {
	it("exposes omp-agent and prime-agent without toolkit markdown files", () => {
		const defs = scanToolkitAgentDefs("/tmp/does-not-exist-agent-pi-toolkit");
		expect(defs.get("omp-agent")?.name).toBe("omp-agent");
		expect(defs.get("prime-agent")?.name).toBe("prime-agent");
		expect(defs.get("omp-agent")?.file).toBe("builtin:omp-agent");
	});
});
