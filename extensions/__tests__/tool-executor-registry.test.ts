import { afterEach, describe, expect, test } from "bun:test";
import toolCaller from "../tool-caller.ts";
import { getToolRegistry } from "../tool-registry.ts";
import { getRegisteredToolExecutors, registerToolWithExecutor } from "../lib/tool-executor-registry.ts";

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
		expect(calls).toHaveLength(1);
	});
});
