import { afterEach, describe, expect, test } from "bun:test";
import composeExec from "../compose-exec.ts";
import { registerToolWithExecutor } from "../lib/tool-executor-registry.ts";
import { resetCapabilitiesForTests } from "../lib/capability-registry.ts";

const EXECUTOR_KEY = "__piRegisteredToolExecutors";

afterEach(() => {
	delete (globalThis as any)[EXECUTOR_KEY];
	resetCapabilitiesForTests();
});

describe("compose_exec", () => {
	test("runs registered extension capabilities in order and returns compact results", async () => {
		const registered: any[] = [];
		const calls: string[] = [];
		const fakePi: any = {
			registerTool(definition: any) { registered.push(definition); },
			registerCommand() {},
			on() {},
		};
		registerToolWithExecutor(fakePi, {
			name: "compose_test_one",
			description: "Read a test value",
			async execute() { calls.push("one"); return { content: [{ type: "text", text: "first" }] }; },
		});
		registerToolWithExecutor(fakePi, {
			name: "compose_test_two",
			description: "Read another test value",
			async execute() { calls.push("two"); return { content: [{ type: "text", text: "second" }] }; },
		});
		composeExec(fakePi);
		const tool = registered.find((entry) => entry.name === "compose_exec");
		const result = await tool.execute("outer", {
			steps: [{ tool: "extensions.compose_test_one" }, { tool: "compose_test_two" }],
		}, undefined, undefined, { cwd: process.cwd() });

		expect(calls).toEqual(["one", "two"]);
		expect(result.details).toMatchObject({ total: 2, completed: 2, failed: 0, parallel: false });
		expect(result.details.results[0].result.text).toBe("first");
	});

	test("blocks recursive composition", async () => {
		const registered: any[] = [];
		const fakePi: any = { registerTool(definition: any) { registered.push(definition); }, registerCommand() {}, on() {} };
		composeExec(fakePi);
		const tool = registered.find((entry) => entry.name === "compose_exec");
		const result = await tool.execute("outer", { steps: [{ tool: "compose_exec" }] }, undefined, undefined, { cwd: process.cwd() });
		expect(result.details).toMatchObject({ total: 1, completed: 0, failed: 1 });
		expect(result.details.results[0].error).toContain("recursion");
	});
});
