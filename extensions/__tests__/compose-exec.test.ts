import { afterEach, describe, expect, test } from "bun:test";
import composeExec from "../compose-exec.ts";
import { registerToolWithExecutor } from "../lib/tool-executor-registry.ts";
import { resetCapabilitiesForTests } from "../lib/capability-registry.ts";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

	test("blocks conflicting non-commutative parallel capabilities", async () => {
		const registered: any[] = [];
		const fakePi: any = { registerTool(definition: any) { registered.push(definition); }, registerCommand() {}, on() {} };
		registerToolWithExecutor(fakePi, { name: "compose_write_one", description: "Write one value", capabilityRisk: "write", capabilityEffect: { resources: ["workspace"], ordering: "ordered" }, async execute() { throw new Error("must not execute"); } });
		registerToolWithExecutor(fakePi, { name: "compose_write_two", description: "Write another value", capabilityRisk: "write", capabilityEffect: { resources: ["workspace"], ordering: "ordered" }, async execute() { throw new Error("must not execute"); } });
		composeExec(fakePi);
		const tool = registered.find((entry) => entry.name === "compose_exec");
		const result = await tool.execute("outer", { parallel: true, steps: [{ tool: "compose_write_one" }, { tool: "compose_write_two" }] }, undefined, undefined, { cwd: process.cwd() });
		expect(result.details.failed).toBe(2);
		expect(result.details.results[0].error).toContain("parallel effect conflict");
	});

	test("passes compact prior output through sequential step references", async () => {
		const registered: any[] = [];
		let received: any;
		const fakePi: any = { registerTool(definition: any) { registered.push(definition); }, registerCommand() {}, on() {} };
		registerToolWithExecutor(fakePi, { name: "compose_source", description: "Source", async execute() { return { content: [{ type: "text", text: "compact answer" }], details: { value: 7 } }; } });
		registerToolWithExecutor(fakePi, { name: "compose_consumer", description: "Consumer", async execute(_id, args) { received = args; return { content: [{ type: "text", text: "consumed" }] }; } });
		composeExec(fakePi);
		const tool = registered.find((entry) => entry.name === "compose_exec");
		const result = await tool.execute("outer", { steps: [
			{ tool: "compose_source" },
			{ tool: "compose_consumer", arguments: { answer: "$STEP_0_TEXT", number: "$STEP_0_DETAILS.value" } },
		] }, undefined, undefined, { cwd: process.cwd() });
		expect(received).toEqual({ answer: "compact answer", number: 7 });
		expect(result.details).toMatchObject({ completed: 2, failed: 0 });
	});

	test("supports safe conditional skips and blocks references in parallel mode", async () => {
		const registered: any[] = [];
		const calls: string[] = [];
		const fakePi: any = { registerTool(definition: any) { registered.push(definition); }, registerCommand() {}, on() {} };
		registerToolWithExecutor(fakePi, { name: "compose_gate", description: "Gate", async execute() { calls.push("gate"); throw new Error("gate failed"); } });
		registerToolWithExecutor(fakePi, { name: "compose_after", description: "After", async execute() { calls.push("after"); return { content: [{ type: "text", text: "after" }] }; } });
		composeExec(fakePi);
		const tool = registered.find((entry) => entry.name === "compose_exec");
		const sequential = await tool.execute("outer", { stop_on_error: false, steps: [
			{ tool: "compose_gate" },
			{ tool: "compose_after", when: { step: 0, status: "failed" } },
		] }, undefined, undefined, { cwd: process.cwd() });
		expect(calls).toEqual(["gate", "after"]);
		expect(sequential.details.results[1].status).toBe("completed");
		const parallel = await tool.execute("outer", { parallel: true, steps: [
			{ tool: "compose_after", arguments: { value: "$STEP_0_TEXT" } },
		] }, undefined, undefined, { cwd: process.cwd() });
		expect(parallel.details.results[0].status).toBe("blocked");
		expect(parallel.details.results[0].error).toContain("sequential mode");
	});

	test("composes the safe built-in read capability and keeps paths inside the workspace", async () => {
		const registered: any[] = [];
		const fakePi: any = { registerTool(definition: any) { registered.push(definition); }, registerCommand() {}, on() {} };
		const cwd = mkdtempSync(join(tmpdir(), "compose-read-"));
		writeFileSync(join(cwd, "input.txt"), "first\nsecond\nthird\n", "utf8");
		const outside = mkdtempSync(join(tmpdir(), "compose-read-outside-"));
		writeFileSync(join(outside, "secret.txt"), "outside-secret", "utf8");
		symlinkSync(join(outside, "secret.txt"), join(cwd, "link.txt"));
		composeExec(fakePi);
		const tool = registered.find((entry) => entry.name === "compose_exec");
		const read = await tool.execute("outer", { steps: [{ tool: "read", arguments: { path: "input.txt", offset: 2, limit: 1 } }] }, undefined, undefined, { cwd });
		expect(read.details).toMatchObject({ completed: 1, failed: 0 });
		expect(read.details.results[0].result.text).toBe("second");
		const blocked = await tool.execute("outer", { steps: [{ tool: "read", arguments: { path: "../outside.txt" } }] }, undefined, undefined, { cwd });
		expect(blocked.details.results[0].status).toBe("completed");
		expect(blocked.details.results[0].result.text).toContain("Read blocked");
		const symlink = await tool.execute("outer", { steps: [{ tool: "read", arguments: { path: "link.txt" } }] }, undefined, undefined, { cwd });
		expect(symlink.details.results[0].result.text).toContain("symlink target");
	});
});
