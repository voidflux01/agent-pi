import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import orchestrationToolAudit, { recordBlockedToolCall, resetBlockedToolAudit } from "../orchestration-tool-audit.ts";
import { setCoordinationMode } from "../lib/coordination-state.ts";

describe("native tool execution audit", () => {
	const roots: string[] = [];

	afterEach(() => {
		setCoordinationMode("NORMAL");
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	test("does not create a duplicate outer run for call_tool", async () => {
		const started: any[] = [];
		const pi: any = { on(event: string, handler: Function) { if (event === "tool_execution_start") started.push(handler); } };
		orchestrationToolAudit(pi);
		await started[0]({ toolCallId: "nested", toolName: "call_tool", args: {} }, { cwd: process.cwd() });
		// The handler intentionally leaves call_tool's RunContext to tool-caller.ts.
		expect(started).toHaveLength(1);
	});

	test("deduplicates blocked decisions from stacked gates", () => {
		const cwd = join(tmpdir(), `pi-tool-audit-blocked-${process.pid}`);
		roots.push(cwd);
		const toolCallId = `blocked-${process.pid}-${Date.now()}`;
		const first = recordBlockedToolCall({ toolCallId, toolName: "bash", category: "approval", reason: "approval required", context: { cwd } });
		const duplicate = recordBlockedToolCall({ toolCallId, toolName: "bash", category: "security_policy", reason: "security policy", context: { cwd } });
		expect(first).toMatch(/^[0-9a-f-]{36}$/);
		expect(duplicate).toBeUndefined();
	});

	test("resets blocked-call de-duplication at a session boundary", () => {
		const cwd = join(tmpdir(), `pi-tool-audit-session-${process.pid}`);
		roots.push(cwd);
		const toolCallId = `session-boundary-${process.pid}-${Date.now()}`;
		const first = recordBlockedToolCall({ toolCallId, toolName: "write", category: "task_gate", context: { cwd } });
		resetBlockedToolAudit();
		const second = recordBlockedToolCall({ toolCallId, toolName: "write", category: "approval", context: { cwd } });
		expect(first).toMatch(/^[0-9a-f-]{36}$/);
		expect(second).toMatch(/^[0-9a-f-]{36}$/);
		expect(second).not.toBe(first);
	});
});
