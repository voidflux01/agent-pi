// ABOUTME: Tests the compact handoff snapshot format and durable round trip.

import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildHandoffSnapshot,
	handoffPath,
	hasMeaningfulHandoff,
	readHandoff,
	renderHandoff,
	renderHandoffPrompt,
	writeHandoff,
} from "../lib/handoff-state.ts";
import handoffExtension from "../session-handoff.ts";

describe("handoff state", () => {
	it("round trips a bounded, meaningful snapshot atomically", () => {
		const workspace = mkdtempSync(join(tmpdir(), "handoff-test-"));
		try {
			const snapshot = buildHandoffSnapshot({
				workspace,
				sessionId: "new",
				status: "in_progress",
				objective: "Finish the feature",
				objectiveSource: "session-state",
				mode: "PLAN",
				tasks: [{ id: 1, text: "Run tests", status: "inprogress" }],
				children: [{ id: "scout-1", agent: "scout", status: "done", task: "Map files", sessionFile: "/tmp/child.jsonl" }],
				nextAction: "Run the test suite",
				context: { todoPath: join(workspace, ".context", "todo.md"), reports: ["report-a.md"] },
				verification: { status: "UNVERIFIED", attempt: 0 },
			});
			writeHandoff(workspace, snapshot);
			expect(readHandoff(workspace)).toEqual(snapshot);
			expect(hasMeaningfulHandoff(snapshot)).toBe(true);
			expect(renderHandoff(snapshot)).toContain("Next action: Run the test suite");
			expect(renderHandoff(snapshot)).toContain("(source: session-state)");
			expect(renderHandoff(snapshot)).toContain("/tmp/child.jsonl");
			expect(renderHandoff(snapshot)).toContain("Plan: ");
			expect(renderHandoff(snapshot)).toContain("Reports: report-a.md");
			expect(renderHandoffPrompt(snapshot)).toContain("Resumable task handoff");
			expect(renderHandoffPrompt(snapshot)).toContain("re-dispatch");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("does not treat a mode-only session as meaningful", () => {
		const workspace = mkdtempSync(join(tmpdir(), "handoff-mode-only-"));
		try {
			const snapshot = buildHandoffSnapshot({ workspace, mode: "SPEC" });
			expect(snapshot.objective).toBe("");
			expect(hasMeaningfulHandoff(snapshot)).toBe(false);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("caps children to actionable runs first and reports the omitted count", () => {
		const workspace = mkdtempSync(join(tmpdir(), "handoff-children-cap-"));
		try {
			const children = [
				...Array.from({ length: 10 }, (_, i) => ({ id: `failed-${i}`, agent: "scout", status: "failed", task: "retry" })),
				{ id: "running-1", agent: "builder", status: "running", task: "build" },
				{ id: "done-1", agent: "scout", status: "succeeded", task: "old evidence" },
			];
			const snapshot = buildHandoffSnapshot({ workspace, objective: "Cap test", children });
			expect(snapshot.children).toHaveLength(8);
			expect(snapshot.children[0]).toMatchObject({ id: "running-1", status: "running" });
			expect(snapshot.children.every((child) => child.id !== "done-1")).toBe(true);
			expect(snapshot.childrenOmitted).toBe(3);
			expect(renderHandoff(snapshot)).toContain("3 more omitted");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("keeps the next action a short executable sentence", () => {
		const workspace = mkdtempSync(join(tmpdir(), "handoff-next-action-"));
		try {
			const longTask = "x".repeat(400);
			const snapshot = buildHandoffSnapshot({
				workspace,
				objective: "Short action",
				children: [{ id: "scout-9", agent: "scout", status: "failed", task: longTask }],
				nextAction: `Re-dispatch scout scout-9: ${longTask}`,
			});
			expect(snapshot.nextAction!.length).toBeLessThanOrEqual(160);
			expect(snapshot.nextAction!.endsWith("…")).toBe(true);
			expect(snapshot.children[0].task!.length).toBeLessThanOrEqual(200);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("rejects a handoff belonging to another workspace", () => {
		const workspace = mkdtempSync(join(tmpdir(), "handoff-test-"));
		try {
			const snapshot = buildHandoffSnapshot({ workspace: "/other", objective: "wrong" });
			writeHandoff(workspace, { ...snapshot, workspace: "/other" });
			expect(readHandoff(workspace)).toBeUndefined();
			expect(handoffPath(workspace)).toContain("handoff.json");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("accepts an equivalent workspace reached through a symlink", () => {
		const workspace = mkdtempSync(join(tmpdir(), "handoff-realpath-"));
		const alias = join(tmpdir(), `handoff-alias-${process.pid}-${Date.now()}`);
		try {
			symlinkSync(workspace, alias, "dir");
			writeHandoff(workspace, buildHandoffSnapshot({ workspace, objective: "Continue through alias" }));
			expect(readHandoff(alias)?.objective).toBe("Continue through alias");
		} finally {
			rmSync(alias, { force: true });
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("resolves a relative snapshot workspace from the handoff workspace", () => {
		const workspace = mkdtempSync(join(tmpdir(), "handoff-relative-"));
		try {
			const snapshot = buildHandoffSnapshot({ workspace, objective: "Continue from relative path" });
			writeHandoff(workspace, { ...snapshot, workspace: "." });
			expect(readHandoff(workspace)?.objective).toBe("Continue from relative path");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("restores a handoff at session start and persists progress on tool results", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "handoff-extension-"));
		const handlers = new Map<string, Function>();
		const notifications: string[] = [];
		const sentMessages: string[] = [];
		let command: any;
		const pi = {
			registerCommand(_name: string, definition: any) { command = definition; },
			registerTool() {},
			sendUserMessage(message: string) { sentMessages.push(message); },
			on(name: string, handler: Function) { handlers.set(name, handler); },
		};
		const ctx: any = {
			cwd: workspace,
			hasUI: true,
			ui: { notify(message: string) { notifications.push(message); } },
			sessionManager: {
				getSessionId: () => "new-session",
				getBranch: () => [{ type: "message", message: { role: "user", content: "Continue the handoff task" } }],
			},
		};
		try {
			writeHandoff(workspace, buildHandoffSnapshot({ workspace, sessionId: "old-session", objective: "Resume this", mode: "PLAN", nextAction: "Inspect evidence" }));
			handoffExtension(pi as any);
			expect(command.getArgumentCompletions("r").map((item: any) => item.value)).toEqual(["resume"]);
		expect(command.getArgumentCompletions("").map((item: any) => item.value)).toEqual(["resume", "complete", "clear"]);
			await handlers.get("session_start")!({ reason: "startup" }, ctx);
			expect(notifications.join("\n")).toContain("Unfinished handoff found");
			expect(readHandoff(workspace)?.status).toBe("interrupted");
			const resumed = await handlers.get("before_agent_start")!({}, ctx);
			expect(resumed.systemPrompt).toContain("Resume this");
			await command.handler("resume", ctx);
			expect(sentMessages).toEqual(["Continue the unfinished task from the queued handoff. Re-check the workspace and proceed from its next action."]);
			(globalThis as any).__piTaskList = { tasks: [{ id: 1, text: "Continue", status: "inprogress" }] };
			await handlers.get("tool_result")!({ toolName: "tasks", result: { details: {} } }, ctx);
			await new Promise((resolve) => setTimeout(resolve, 550));
			expect(JSON.parse(readFileSync(handoffPath(workspace), "utf8")).tasks[0].text).toBe("Continue");
			await command.handler("clear", ctx);
			expect(readHandoff(workspace)).toBeUndefined();
			(globalThis as any).__piTaskList = { tasks: [{ id: 1, text: "Still open", status: "inprogress" }] };
			await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
			expect(readHandoff(workspace)).toBeUndefined();
			delete (globalThis as any).__piTaskList;
		} finally {
			await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
			delete (globalThis as any).__piTaskList;
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("does not resurrect an interrupted handoff on a dirty, idle shutdown", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "handoff-dirty-shutdown-"));
		const handlers = new Map<string, Function>();
		const notifications: string[] = [];
		const pi = {
			registerCommand() {},
			registerTool() {},
			on(name: string, handler: Function) { handlers.set(name, handler); },
		};
		const ctx: any = {
			cwd: workspace,
			hasUI: true,
			ui: { notify(message: string) { notifications.push(message); } },
			sessionManager: { getSessionId: () => "new-session" },
		};
		try {
			writeFileSync(join(workspace, "dirty.file"), "uncommitted work\n", "utf8");
			(globalThis as any).__piTaskList = { tasks: [{ id: 1, text: "Open task", status: "inprogress" }] };
			writeHandoff(workspace, buildHandoffSnapshot({ workspace, sessionId: "old-session", objective: "Cross-session work", status: "in_progress" }));
			handoffExtension(pi as any);
			await handlers.get("session_start")!({ reason: "startup" }, ctx);
			expect(notifications.join("\n")).toContain("Unfinished handoff found");
			expect(readHandoff(workspace)?.status).toBe("interrupted");
			await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
			// Dirty git tree and open tasks exist, but this session took no action:
			// the interrupted downgrade must survive the shutdown.
			expect(readHandoff(workspace)?.status).toBe("interrupted");
			const before = notifications.length;
			await handlers.get("session_start")!({ reason: "startup" }, ctx);
			expect(notifications).toHaveLength(before);
		} finally {
			await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
			delete (globalThis as any).__piTaskList;
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("does not warn when the interrupted downgrade cannot be written", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "handoff-write-failure-"));
		const handlers = new Map<string, Function>();
		const notifications: string[] = [];
		const pi = {
			registerCommand() {},
			registerTool() {},
			on(name: string, handler: Function) { handlers.set(name, handler); },
		};
		const ctx: any = {
			cwd: workspace,
			hasUI: true,
			ui: { notify(message: string) { notifications.push(message); } },
			sessionManager: { getSessionId: () => "new-session" },
		};
		const piDir = join(workspace, ".pi");
		mkdirSync(piDir);
		try {
			writeHandoff(workspace, buildHandoffSnapshot({ workspace, sessionId: "old-session", objective: "Locked handoff", status: "in_progress" }));
			chmodSync(piDir, 0o500);
			handoffExtension(pi as any);
			await handlers.get("session_start")!({ reason: "startup" }, ctx);
			expect(notifications).toEqual([]);
		} finally {
			chmodSync(piDir, 0o700);
			await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("downgrades a stale handoff on session_switch", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "handoff-switch-"));
		const handlers = new Map<string, Function>();
		const pi = {
			registerCommand() {},
			registerTool() {},
			on(name: string, handler: Function) { handlers.set(name, handler); },
		};
		const ctx: any = {
			cwd: workspace,
			hasUI: true,
			ui: { notify() {} },
			sessionManager: { getSessionId: () => "replacement-session" },
		};
		try {
			writeHandoff(workspace, buildHandoffSnapshot({ workspace, sessionId: "outgoing-session", objective: "Mid-run work", status: "in_progress" }));
			handoffExtension(pi as any);
			await handlers.get("session_before_switch")!({ reason: "switch" }, ctx);
			expect(readHandoff(workspace)?.status).toBe("interrupted");
		} finally {
			await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("prefers the curated session-state objective over the task list", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "handoff-objective-source-"));
		const handlers = new Map<string, Function>();
		const contextDir = join(workspace, ".context");
		mkdirSync(contextDir, { recursive: true });
		writeFileSync(join(contextDir, "session-state.json"), JSON.stringify({
			$schema: "session-state-v2",
			continue: "Design is settled; implement the matrix next.",
			task: "Refactor the handoff feature",
		}), "utf8");
		const pi = {
			registerCommand() {},
			registerTool() {},
			on(name: string, handler: Function) { handlers.set(name, handler); },
		};
		const ctx: any = { cwd: workspace, sessionManager: { getSessionId: () => "new-session" } };
		try {
			(globalThis as any).__piTaskList = { tasks: [{ id: 1, text: "Task list objective", status: "inprogress" }] };
			handoffExtension(pi as any);
			await handlers.get("tool_result")!({ toolName: "tasks", result: { details: {} } }, ctx);
			await new Promise((resolve) => setTimeout(resolve, 550));
			const snapshot = JSON.parse(readFileSync(handoffPath(workspace), "utf8"));
			expect(snapshot.objective).toBe("Design is settled; implement the matrix next.");
			expect(snapshot.objectiveSource).toBe("session-state");
		} finally {
			await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
			delete (globalThis as any).__piTaskList;
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("falls back to the task list objective when no session state exists", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "handoff-task-objective-"));
		const handlers = new Map<string, Function>();
		const pi = {
			registerCommand() {},
			registerTool() {},
			on(name: string, handler: Function) { handlers.set(name, handler); },
		};
		const ctx: any = { cwd: workspace, sessionManager: { getSessionId: () => "new-session" } };
		try {
			(globalThis as any).__piTaskList = { tasks: [{ id: 7, text: "Finish the verifier integration", status: "inprogress" }] };
			handoffExtension(pi as any);
			await handlers.get("tool_result")!({ toolName: "tasks", result: { details: {} } }, ctx);
			await new Promise((resolve) => setTimeout(resolve, 550));
			const snapshot = JSON.parse(readFileSync(handoffPath(workspace), "utf8"));
			expect(snapshot.objective).toBe("Finish the verifier integration");
			expect(snapshot.objectiveSource).toBe("task-list");
			expect(snapshot.nextAction).toBe("Continue task #7: Finish the verifier integration");
		} finally {
			await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
			delete (globalThis as any).__piTaskList;
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("does not warn repeatedly for an already-interrupted handoff", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "handoff-interrupted-"));
		const handlers = new Map<string, Function>();
		const notifications: string[] = [];
		const pi = {
			registerCommand() {},
			registerTool() {},
			on(name: string, handler: Function) { handlers.set(name, handler); },
		};
		const ctx: any = {
			cwd: workspace,
			sessionManager: { getSessionId: () => "new-session" },
			ui: { notify(message: string) { notifications.push(message); } },
		};
		try {
			writeHandoff(workspace, buildHandoffSnapshot({ workspace, sessionId: "old-session", objective: "Resume this", status: "interrupted" }));
			handoffExtension(pi as any);
			await handlers.get("session_start")!({ reason: "startup" }, ctx);
			expect(notifications).toHaveLength(0);
		} finally {
			await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("does not consume the parent handoff in a child Pi session", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "handoff-child-"));
		const handlers = new Map<string, Function>();
		const notifications: string[] = [];
		const pi = {
			registerCommand() {},
			registerTool() {},
			on(name: string, handler: Function) { handlers.set(name, handler); },
		};
		const ctx: any = {
			cwd: workspace,
			hasUI: true,
			ui: { notify(message: string) { notifications.push(message); } },
			sessionManager: { getSessionId: () => "child-session" },
		};
		const previous = process.env.PI_SUBAGENT;
		try {
			writeHandoff(workspace, buildHandoffSnapshot({ workspace, sessionId: "parent-session", objective: "Parent work", mode: "NORMAL" }));
			process.env.PI_SUBAGENT = "1";
			handoffExtension(pi as any);
			await handlers.get("session_start")!({ reason: "startup" }, ctx);
			expect(notifications).toEqual([]);
			expect(await handlers.get("before_agent_start")!({}, ctx)).toEqual({});
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENT;
			else process.env.PI_SUBAGENT = previous;
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("does not resurrect a handoff when resume is the only action", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "handoff-idle-resume-"));
		const handlers = new Map<string, Function>();
		let resumeTool: any;
		const pi = {
			registerCommand() {},
			registerTool(_definition: any) { resumeTool = _definition; },
			on(name: string, handler: Function) { handlers.set(name, handler); },
		};
		const ctx: any = {
			cwd: workspace,
			sessionManager: { getSessionId: () => "resumed-session" },
		};
		try {
			const original = buildHandoffSnapshot({
				workspace,
				sessionId: "old-session",
				objective: "Inspect reconciliation tables",
				status: "in_progress",
			});
			writeHandoff(workspace, original);
			handoffExtension(pi as any);
			await handlers.get("session_start")!({ reason: "startup" }, ctx);
			await resumeTool.execute("resume", {}, undefined, undefined, ctx);
			await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
			const after = readHandoff(workspace)!;
			expect(after.status).toBe("interrupted");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("keeps only canonical resumable journal rows in a generated handoff", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "handoff-journal-status-"));
		const handlers = new Map<string, Function>();
		const journalDir = join(workspace, ".pi", "agent-sessions");
		mkdirSync(journalDir, { recursive: true });
		writeFileSync(join(journalDir, "task-journal.jsonl"), [
			{ version: 1, id: "cancelled", kind: "team", agent: "builder", task: "cancelled task", status: "error", runStatus: "cancelled", startedAt: Date.now(), updatedAt: Date.now() },
			{ version: 1, id: "unknown", kind: "team", agent: "builder", task: "corrupt task", status: "mystery", startedAt: Date.now(), updatedAt: Date.now() },
			{ version: 1, id: "failed", kind: "team", agent: "builder", task: "retry task", status: "error", runStatus: "failed", startedAt: Date.now(), updatedAt: Date.now() },
		].map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
		const pi = {
			registerCommand() {},
			registerTool() {},
			on(name: string, handler: Function) { handlers.set(name, handler); },
		};
		const ctx: any = { cwd: workspace, sessionManager: { getSessionId: () => "new-session" } };
		try {
			handoffExtension(pi as any);
			await handlers.get("tool_result")!({ toolName: "tasks", result: { details: {} } }, ctx);
			await new Promise((resolve) => setTimeout(resolve, 550));
			const snapshot = JSON.parse(readFileSync(handoffPath(workspace), "utf8"));
			expect(snapshot.children).toHaveLength(1);
			expect(snapshot.children[0]).toMatchObject({ id: "failed", status: "failed" });
		} finally {
			await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});
