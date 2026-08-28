// ABOUTME: Test suite for the tasks blocking gate bypass logic.
// ABOUTME: Validates which tools are allowed to bypass the task-definition gate.

import { describe, it, expect } from "vitest";

import { shouldBypassTaskGate } from "../lib/task-gate.ts";

describe("shouldBypassTaskGate", () => {
	it("should bypass for 'tasks' tool", () => {
		expect(shouldBypassTaskGate("tasks")).toBe(true);
	});

	it("should bypass for 'dispatch_agent' tool", () => {
		expect(shouldBypassTaskGate("dispatch_agent")).toBe(true);
	});

	it("should bypass for 'dispatch_agents' tool", () => {
		expect(shouldBypassTaskGate("dispatch_agents")).toBe(true);
	});

	it("should bypass for 'ask_user' tool (communication tool)", () => {
		expect(shouldBypassTaskGate("ask_user")).toBe(true);
	});

	it("should bypass for 'run_chain' tool (orchestration tool)", () => {
		expect(shouldBypassTaskGate("run_chain")).toBe(true);
	});

	it("should NOT bypass for 'bash' tool", () => {
		expect(shouldBypassTaskGate("bash")).toBe(false);
	});

	it("should NOT bypass for 'read_file' tool", () => {
		expect(shouldBypassTaskGate("read_file")).toBe(false);
	});

	it("should NOT bypass for 'write_file' tool", () => {
		expect(shouldBypassTaskGate("write_file")).toBe(false);
	});

	it("should NOT bypass for empty string", () => {
		expect(shouldBypassTaskGate("")).toBe(false);
	});

	it("should bypass for 'commander_task' tool", () => {
		expect(shouldBypassTaskGate("commander_task")).toBe(true);
	});

	it("should bypass for 'commander_session' tool", () => {
		expect(shouldBypassTaskGate("commander_session")).toBe(true);
	});

	it("should bypass for 'commander_mailbox' tool", () => {
		expect(shouldBypassTaskGate("commander_mailbox")).toBe(true);
	});

	it("should bypass for any commander_* prefixed tool", () => {
		expect(shouldBypassTaskGate("commander_workflow")).toBe(true);
		expect(shouldBypassTaskGate("commander_orchestration")).toBe(true);
		expect(shouldBypassTaskGate("commander_dependency")).toBe(true);
	});

	it("should bypass for 'advance_phase' pipeline tool", () => {
		expect(shouldBypassTaskGate("advance_phase")).toBe(true);
	});

	it("should bypass for 'pipeline_status' pipeline tool", () => {
		expect(shouldBypassTaskGate("pipeline_status")).toBe(true);
	});
});

describe("read-only tool bypass", () => {
	it("should bypass for 'read' tool", () => {
		expect(shouldBypassTaskGate("read")).toBe(true);
	});

	it("should bypass for 'grep' tool", () => {
		expect(shouldBypassTaskGate("grep")).toBe(true);
	});

	it("should bypass for 'find' tool", () => {
		expect(shouldBypassTaskGate("find")).toBe(true);
	});

	it("should bypass for 'ls' tool", () => {
		expect(shouldBypassTaskGate("ls")).toBe(true);
	});

	it("should bypass for 'glob' tool", () => {
		expect(shouldBypassTaskGate("glob")).toBe(true);
	});

	it("should NOT bypass for 'write' tool (write operation)", () => {
		expect(shouldBypassTaskGate("write")).toBe(false);
	});

	it("should NOT bypass for 'edit' tool (write operation)", () => {
		expect(shouldBypassTaskGate("edit")).toBe(false);
	});

	it("should NOT bypass for 'bash' tool (write operation)", () => {
		expect(shouldBypassTaskGate("bash")).toBe(false);
	});
});

describe("PI_SUBAGENT env var bypass", () => {
	function shouldBypassForSubagent(): boolean {
		return process.env.PI_SUBAGENT === "1";
	}

	it("should bypass entire gate when PI_SUBAGENT=1", () => {
		const original = process.env.PI_SUBAGENT;
		process.env.PI_SUBAGENT = "1";
		expect(shouldBypassForSubagent()).toBe(true);
		if (original === undefined) delete process.env.PI_SUBAGENT;
		else process.env.PI_SUBAGENT = original;
	});

	it("should NOT bypass when PI_SUBAGENT is unset", () => {
		const original = process.env.PI_SUBAGENT;
		delete process.env.PI_SUBAGENT;
		expect(shouldBypassForSubagent()).toBe(false);
		if (original !== undefined) process.env.PI_SUBAGENT = original;
	});

	it("should NOT bypass when PI_SUBAGENT is 0", () => {
		const original = process.env.PI_SUBAGENT;
		process.env.PI_SUBAGENT = "0";
		expect(shouldBypassForSubagent()).toBe(false);
		if (original === undefined) delete process.env.PI_SUBAGENT;
		else process.env.PI_SUBAGENT = original;
	});
});
