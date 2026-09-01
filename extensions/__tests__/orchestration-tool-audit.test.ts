import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import orchestrationToolAudit, { recordBlockedToolCall } from "../orchestration-tool-audit.ts";
import { readOrchestrationEvents } from "../lib/orchestration-query.ts";
import { setCoordinationMode } from "../lib/coordination-state.ts";

describe("native tool execution audit", () => {
	const roots: string[] = [];

	afterEach(() => {
		setCoordinationMode("NORMAL");
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	test("records direct tool lifecycles for NORMAL, PLAN, and SPEC", async () => {
		const handlers = new Map<string, Function>();
		const pi: any = { on(event: string, handler: Function) { handlers.set(event, handler); } };
		orchestrationToolAudit(pi);

		for (const [index, mode] of ["NORMAL", "PLAN", "SPEC"].entries()) {
			const cwd = join(tmpdir(), `pi-tool-audit-${process.pid}-${index}`);
			roots.push(cwd);
			setCoordinationMode(mode as any);
			const toolCallId = `direct-${index}`;
			await handlers.get("tool_execution_start")?.({ type: "tool_execution_start", toolCallId, toolName: "read", args: {} }, { cwd });
			await handlers.get("tool_execution_end")?.({ type: "tool_execution_end", toolCallId, toolName: "read", result: { content: [] }, isError: index === 2 });

			const runRoot = join(cwd, ".pi", "agent-sessions", "compositions");
			const runId = readdirSync(runRoot)[0];
			const events = readOrchestrationEvents(join(runRoot, runId));
			expect(events.find((event) => event.type === "run.started")?.payload).toMatchObject({ data: { mode } });
			expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["tool.started", "tool.completed", index === 2 ? "run.failed" : "run.succeeded"]));
		}
	});

	test("does not create a duplicate outer run for call_tool", async () => {
		const started: any[] = [];
		const pi: any = { on(event: string, handler: Function) { if (event === "tool_execution_start") started.push(handler); } };
		orchestrationToolAudit(pi);
		await started[0]({ toolCallId: "nested", toolName: "call_tool", args: {} }, { cwd: process.cwd() });
		// The handler intentionally leaves call_tool's RunContext to tool-caller.ts.
		const compositionRoot = join(process.cwd(), ".pi", "agent-sessions", "compositions");
		expect(started).toHaveLength(1);
	});

	test("captures changed workspace files for direct write tools", async () => {
		const handlers = new Map<string, Function>();
		const pi: any = { on(event: string, handler: Function) { handlers.set(event, handler); } };
		orchestrationToolAudit(pi);
		const cwd = join(tmpdir(), `pi-tool-audit-write-${process.pid}`);
		roots.push(cwd);
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, "before.txt"), "before\n");
		execFileSync("git", ["init", "-q"], { cwd });
		execFileSync("git", ["add", "before.txt"], { cwd });
		await handlers.get("tool_execution_start")?.({ type: "tool_execution_start", toolCallId: "write-1", toolName: "write", args: { path: "after.txt" } }, { cwd });
		writeFileSync(join(cwd, "after.txt"), "after\n");
		await handlers.get("tool_execution_end")?.({ type: "tool_execution_end", toolCallId: "write-1", toolName: "write", result: { content: [] }, isError: false });

		const runRoot = join(cwd, ".pi", "agent-sessions", "compositions");
		const runId = readdirSync(runRoot)[0];
		const changed = readOrchestrationEvents(join(runRoot, runId)).find((event) => event.type === "workspace.changed");
		expect(changed?.payload).toMatchObject({ data: { changedFiles: ["after.txt"] } });
	});

	test("deduplicates blocked decisions from stacked gates", () => {
		const cwd = join(tmpdir(), `pi-tool-audit-blocked-${process.pid}`);
		roots.push(cwd);
		const toolCallId = `blocked-${process.pid}-${Date.now()}`;
		const first = recordBlockedToolCall({ toolCallId, toolName: "bash", category: "approval", reason: "approval required", context: { cwd } });
		const duplicate = recordBlockedToolCall({ toolCallId, toolName: "bash", category: "security_policy", reason: "security policy", context: { cwd } });
		expect(first).toMatch(/^[A-Za-z0-9-]+$/);
		expect(duplicate).toBeUndefined();
		const events = readOrchestrationEvents(join(cwd, ".pi", "agent-sessions", "compositions", first!));
		expect(events.filter((event) => event.type === "tool.blocked")).toHaveLength(1);
		expect(events.find((event) => event.type === "tool.blocked")?.payload).toMatchObject({ data: { category: "approval" } });
	});
});
