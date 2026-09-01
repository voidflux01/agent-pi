import { afterEach, describe, expect, test } from "bun:test";
import composeExec from "../compose-exec.ts";
import { registerToolWithExecutor } from "../lib/tool-executor-registry.ts";
import { registerDiscoveredCapability, resetCapabilitiesForTests } from "../lib/capability-registry.ts";
import { listRunEvents } from "../lib/evidence-store.ts";
import { activeRunMarkerPath, createOrchestrationRun } from "../lib/orchestration-run.ts";
import { existsSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
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

	test("retries transient step errors within a bounded attempt budget", async () => {
		const registered: any[] = [];
		let calls = 0;
		const fakePi: any = { registerTool(definition: any) { registered.push(definition); }, registerCommand() {}, on() {} };
		registerToolWithExecutor(fakePi, { name: "compose_flaky", description: "Flaky", async execute() { calls += 1; if (calls < 3) throw new Error("transient"); return { content: [{ type: "text", text: "recovered" }] }; } });
		composeExec(fakePi);
		const tool = registered.find((entry) => entry.name === "compose_exec");
		const result = await tool.execute("outer", { steps: [{ tool: "compose_flaky", retry: 2 }] }, undefined, undefined, { cwd: process.cwd() });
		expect(calls).toBe(3);
		expect(result.details).toMatchObject({ completed: 1, failed: 0 });
		expect(result.details.results[0].attempts).toBe(3);
		const retryEvents = listRunEvents(result.details.eventDir).map((event) => event.type);
		expect(retryEvents.filter((type) => type === "step.retrying")).toHaveLength(2);

		calls = 0;
		const exhausted = await tool.execute("outer", { steps: [{ tool: "compose_flaky", retry: 1 }] }, undefined, undefined, { cwd: process.cwd() });
		expect(calls).toBe(2);
		expect(exhausted.details.results[0]).toMatchObject({ status: "failed", attempts: 2 });
	});

	test("aborts a step that exceeds its bounded timeout", async () => {
		const registered: any[] = [];
		let aborted = false;
		const fakePi: any = { registerTool(definition: any) { registered.push(definition); }, registerCommand() {}, on() {} };
		registerToolWithExecutor(fakePi, {
			name: "compose_slow",
			description: "Slow",
			async execute(_id, _args, stepSignal) {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, 100);
					stepSignal?.addEventListener("abort", () => { aborted = true; clearTimeout(timer); resolve(); }, { once: true });
				});
				if (aborted) throw new Error("aborted by timeout");
				return { content: [{ type: "text", text: "unexpected" }] };
			},
		});
		composeExec(fakePi);
		const tool = registered.find((entry) => entry.name === "compose_exec");
		const result = await tool.execute("outer", { steps: [{ tool: "compose_slow", timeout_ms: 10 }] }, undefined, undefined, { cwd: process.cwd() });
		expect(aborted).toBe(true);
		expect(result.details.results[0]).toMatchObject({ status: "failed" });
		expect(result.details.results[0].error).toContain("timed out");
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

	test("replaces an underspecified discovered read capability with the safe schema", async () => {
		const registered: any[] = [];
		const fakePi: any = { registerTool(definition: any) { registered.push(definition); }, registerCommand() {}, on() {} };
		registerDiscoveredCapability({ name: "read", provider: "builtin", description: "Native read without an exposed schema" });
		composeExec(fakePi);
		const tool = registered.find((entry) => entry.name === "compose_exec");
		const result = await tool.execute("outer", { steps: [{ tool: "read", arguments: { path: "input.txt", offset: 0 } }] }, undefined, undefined, { cwd: process.cwd() });
		expect(result.details.results[0].status).toBe("blocked");
		expect(result.details.results[0].error).toContain("invalid arguments");
	});

	test("composes workspace-bounded writes and rejects escaping parents", async () => {
		const registered: any[] = [];
		const fakePi: any = { registerTool(definition: any) { registered.push(definition); }, registerCommand() {}, on() {} };
		const cwd = mkdtempSync(join(tmpdir(), "compose-write-"));
		const outside = mkdtempSync(join(tmpdir(), "compose-write-outside-"));
		symlinkSync(outside, join(cwd, "redirect"), "dir");
		composeExec(fakePi);
		const tool = registered.find((entry) => entry.name === "compose_exec");
		const written = await tool.execute("outer", { steps: [{ tool: "write", arguments: { path: "nested/output.txt", content: "created" } }] }, undefined, undefined, { cwd });
		expect(written.details).toMatchObject({ completed: 1, failed: 0 });
		expect(readFileSync(join(cwd, "nested/output.txt"), "utf8")).toBe("created");
		const blocked = await tool.execute("outer", { steps: [{ tool: "write", arguments: { path: "redirect/escape.txt", content: "nope" } }] }, undefined, undefined, { cwd });
		expect(blocked.details.results[0].result.text).toContain("parent symlink");
		expect(existsSync(join(outside, "escape.txt"))).toBe(false);
	});

	test("blocks parallel read/write batches sharing the workspace", async () => {
		const registered: any[] = [];
		const fakePi: any = { registerTool(definition: any) { registered.push(definition); }, registerCommand() {}, on() {} };
		const cwd = mkdtempSync(join(tmpdir(), "compose-conflict-"));
		writeFileSync(join(cwd, "input.txt"), "input", "utf8");
		composeExec(fakePi);
		const tool = registered.find((entry) => entry.name === "compose_exec");
		const result = await tool.execute("outer", { parallel: true, steps: [
			{ tool: "read", arguments: { path: "input.txt" } },
			{ tool: "write", arguments: { path: "output.txt", content: "output" } },
		] }, undefined, undefined, { cwd });
		expect(result.details.failed).toBe(2);
		expect(result.details.results[0].error).toContain("parallel effect conflict");
		expect(existsSync(join(cwd, "output.txt"))).toBe(false);
	});

	test("composes exact edits and refuses ambiguous matches", async () => {
		const registered: any[] = [];
		const fakePi: any = { registerTool(definition: any) { registered.push(definition); }, registerCommand() {}, on() {} };
		const cwd = mkdtempSync(join(tmpdir(), "compose-edit-"));
		writeFileSync(join(cwd, "input.txt"), "alpha\nbeta\nbeta\n", "utf8");
		composeExec(fakePi);
		const tool = registered.find((entry) => entry.name === "compose_exec");
		const ambiguous = await tool.execute("outer", { steps: [{ tool: "edit", arguments: { path: "input.txt", oldText: "beta", newText: "gamma" } }] }, undefined, undefined, { cwd });
		expect(ambiguous.details.results[0].result.text).toContain("matched 2 locations");
		expect(readFileSync(join(cwd, "input.txt"), "utf8")).toBe("alpha\nbeta\nbeta\n");
		const edited = await tool.execute("outer", { steps: [{ tool: "edit", arguments: { path: "input.txt", oldText: "beta", newText: "gamma", replaceAll: true } }] }, undefined, undefined, { cwd });
		expect(edited.details).toMatchObject({ completed: 1, failed: 0 });
		expect(readFileSync(join(cwd, "input.txt"), "utf8")).toBe("alpha\ngamma\ngamma\n");
	});

	test("composes security-checked bash with a bounded timeout schema", async () => {
		const registered: any[] = [];
		const executions: any[] = [];
		const fakePi: any = {
			registerTool(definition: any) { registered.push(definition); },
			registerCommand() {},
			on() {},
			async exec(binary: string, args: string[], options: any) {
				executions.push({ binary, args, options });
				return { code: 0, stdout: "bash-result", stderr: "" };
			},
		};
		const cwd = mkdtempSync(join(tmpdir(), "compose-bash-"));
		composeExec(fakePi);
		const tool = registered.find((entry) => entry.name === "compose_exec");
		const result = await tool.execute("outer", { steps: [{ tool: "bash", arguments: { command: "printf bash-result", timeout: 12 } }] }, undefined, undefined, { cwd });
		expect(result.details).toMatchObject({ completed: 1, failed: 0 });
		expect(result.details.results[0].result.text).toBe("bash-result");
		expect(executions[0]).toMatchObject({ binary: "bash", args: ["-c", "printf bash-result"], options: { cwd, timeout: 12000 } });
		const invalid = await tool.execute("outer", { steps: [{ tool: "bash", arguments: { command: "true", timeout: 601 } }] }, undefined, undefined, { cwd });
		expect(invalid.details.results[0].status).toBe("blocked");
		expect(invalid.details.results[0].error).toContain("invalid arguments");
	});

	test("does not parallelize bash with workspace file operations", async () => {
		const registered: any[] = [];
		const fakePi: any = { registerTool(definition: any) { registered.push(definition); }, registerCommand() {}, on() {}, async exec() { throw new Error("must not execute"); } };
		const cwd = mkdtempSync(join(tmpdir(), "compose-bash-conflict-"));
		writeFileSync(join(cwd, "input.txt"), "input", "utf8");
		composeExec(fakePi);
		const tool = registered.find((entry) => entry.name === "compose_exec");
		const result = await tool.execute("outer", { parallel: true, steps: [
			{ tool: "bash", arguments: { command: "cat input.txt" } },
			{ tool: "read", arguments: { path: "input.txt" } },
		] }, undefined, undefined, { cwd });
		expect(result.details.failed).toBe(2);
		expect(result.details.results[0].error).toContain("parallel effect conflict");
	});

	test("persists a bounded completed-step handoff for restart inspection", async () => {
		const registered: any[] = [];
		const fakePi: any = { registerTool(definition: any) { registered.push(definition); }, registerCommand() {}, on() {} };
		const cwd = mkdtempSync(join(tmpdir(), "compose-events-"));
		writeFileSync(join(cwd, "input.txt"), "recoverable", "utf8");
		composeExec(fakePi);
		const tool = registered.find((entry) => entry.name === "compose_exec");
		const sessionFile = join(cwd, ".pi", "agent-sessions", "parent.jsonl");
		const result = await tool.execute("outer", { steps: [{ tool: "read", arguments: { path: "input.txt" } }] }, undefined, undefined, {
			cwd,
			sessionManager: { getSessionFile: () => sessionFile },
		});
		const events = listRunEvents(join(cwd, ".pi", "agent-sessions", "compositions", result.details.runId));
		const completed = events.find((event) => event.type === "step.completed");
		expect(completed?.payload).toMatchObject({ data: { result: { text: "recoverable" } } });
	});

	test("resumes a stale composition and reuses completed step results", async () => {
		const registered: any[] = [];
		const fakePi: any = { registerTool(definition: any) { registered.push(definition); }, registerCommand() {}, on() {} };
		const cwd = mkdtempSync(join(tmpdir(), "compose-resume-"));
		const sessionFile = join(cwd, ".pi", "agent-sessions", "parent.jsonl");
		const sourceSeedDir = join(cwd, ".pi", "agent-sessions", "compositions", "source-seed");
		const source = createOrchestrationRun({ eventDir: sourceSeedDir, actor: "compose_exec", mode: "PLAN" });
		source.record("composition.started", { steps: [{ tool: "read", arguments: { path: "already.txt" } }] });
		source.record("step.completed", { index: 0, tool: "read", result: { text: "reused", details: { path: "already.txt" } } });
		const sourceDir = join(cwd, ".pi", "agent-sessions", "compositions", source.runId);
		renameSync(sourceSeedDir, sourceDir);
		writeFileSync(activeRunMarkerPath(sourceDir), JSON.stringify({ pid: 2147483647 }));
		composeExec(fakePi);
		const tool = registered.find((entry) => entry.name === "compose_exec");
		const result = await tool.execute("outer", { resume_run_id: source.runId }, undefined, undefined, {
			cwd,
			sessionManager: { getSessionFile: () => sessionFile },
		});
		expect(result.details).toMatchObject({ resumeOf: source.runId, reusedSteps: [0], completed: 1, failed: 0 });
		expect(result.details.results[0].result.text).toBe("reused");
	});
});
