import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import toolCaller from "../tool-caller.ts";
import { getToolRegistry } from "../tool-registry.ts";
import { getRegisteredToolExecutors, registerToolWithExecutor } from "../lib/tool-executor-registry.ts";
import { readOrchestrationEvents } from "../lib/orchestration-query.ts";

const EXECUTOR_KEY = "__piRegisteredToolExecutors";

afterEach(() => {
	delete (globalThis as any)[EXECUTOR_KEY];
});

describe("extension tool executor registry", () => {
	test("publishes the same executable definition that Pi receives", async () => {
		const registered: any[] = [];
		const execute = async () => ({ content: [{ type: "text" as const, text: "ok" }] });
		registerToolWithExecutor({ registerTool: (definition) => registered.push(definition) }, {
			name: "registry_test_tool",
			execute,
		});

		expect(registered).toHaveLength(1);
		expect(registered[0].execute).toBe(execute);
		expect(getRegisteredToolExecutors().registry_test_tool).toBe(execute);
	});

	test("lets call_tool execute a registered extension handler in-process", async () => {
		const calls: any[] = [];
		const execute = async (...args: any[]) => {
			calls.push(args);
			return { content: [{ type: "text" as const, text: "extension executed" }], details: { ok: true } };
		};
		registerToolWithExecutor({ registerTool: () => {} }, { name: "registry_call_tool_target", execute });
		getToolRegistry().buildIndex([{ name: "registry_call_tool_target", description: "test target" }]);

		const handlers = new Map<string, Function[]>();
		let callTool: any;
		const pi: any = {
			registerTool(definition: any) { callTool = definition; },
			getAllTools: () => [{ name: "registry_call_tool_target", description: "test target" }],
			on(event: string, handler: Function) { handlers.set(event, [...(handlers.get(event) || []), handler]); },
		};
		toolCaller(pi);
		for (const handler of handlers.get("session_start") || []) await handler({}, {});

		const result = await callTool.execute("outer", {
			tool_name: "registry_call_tool_target",
			arguments: { value: 1 },
			reason: "registry test",
		}, undefined, undefined, { cwd: process.cwd() });

		expect(result.content[0].text).toBe("extension executed");
		expect(result.details).toMatchObject({ tool_name: "registry_call_tool_target", proxied: true, originalDetails: { ok: true } });
		expect(result.details.runId).toMatch(/^[A-Za-z0-9-]+$/);
		const eventDir = join(process.cwd(), ".pi", "agent-sessions", "compositions", result.details.runId);
		const eventTypes = readOrchestrationEvents(eventDir).map((event) => event.type);
		expect(eventTypes).toEqual(expect.arrayContaining(["tool.started", "tool.completed", "run.succeeded"]));
		rmSync(eventDir, { recursive: true, force: true });
		expect(calls).toHaveLength(1);
	});

	test("refreshes the executor cache when an extension loads after session_start", async () => {
		let callTool: any;
		const lateExecute = async () => ({ content: [{ type: "text" as const, text: "late extension executed" }] });
		const handlers = new Map<string, Function[]>();
		const tools: any[] = [];
		const pi: any = {
			registerTool(definition: any) { if (definition.name === "call_tool") callTool = definition; tools.push({ name: definition.name, description: definition.description }); },
			getAllTools: () => tools,
			on(event: string, handler: Function) { handlers.set(event, [...(handlers.get(event) || []), handler]); },
		};
		toolCaller(pi);
		for (const handler of handlers.get("session_start") || []) await handler({}, {});
		registerToolWithExecutor({ registerTool: (definition) => tools.push({ name: definition.name, description: definition.description }) }, {
			name: "registry_late_target", execute: lateExecute,
		});

		const result = await callTool.execute("outer", { tool_name: "registry_late_target", arguments: {} }, undefined, undefined, { cwd: process.cwd() });
		expect(result.content[0].text).toBe("late extension executed");
		expect(result.details.proxied).toBe(true);
		expect(result.details.runId).toMatch(/^[A-Za-z0-9-]+$/);
	});

	test("records an aborted proxied call as cancelled", async () => {
		let callTool: any;
		const handlers = new Map<string, Function[]>();
		const tools: any[] = [];
		registerToolWithExecutor({ registerTool: (definition) => tools.push({ name: definition.name, description: definition.description }) }, {
			name: "registry_cancel_target",
			execute: async () => ({ content: [{ type: "text" as const, text: "completed after cancellation" }] }),
		});
		const pi: any = {
			registerTool(definition: any) { if (definition.name === "call_tool") callTool = definition; },
			getAllTools: () => [...tools, { name: "call_tool", description: "proxy" }],
			on(event: string, handler: Function) { handlers.set(event, [...(handlers.get(event) || []), handler]); },
		};
		toolCaller(pi);
		for (const handler of handlers.get("session_start") || []) await handler({}, {});
		const controller = new AbortController();
		controller.abort();
		const result = await callTool.execute("outer", { tool_name: "registry_cancel_target", arguments: {} }, controller.signal, undefined, { cwd: process.cwd() });
		expect(result.details.runId).toMatch(/^[A-Za-z0-9-]+$/);
		const eventDir = join(process.cwd(), ".pi", "agent-sessions", "compositions", result.details.runId);
		const completed = readOrchestrationEvents(eventDir).find((event) => event.type === "tool.completed");
		expect(completed?.payload).toMatchObject({ data: { status: "cancelled" } });
		rmSync(eventDir, { recursive: true, force: true });
	});
});
