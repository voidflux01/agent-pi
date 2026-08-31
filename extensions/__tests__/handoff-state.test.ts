// ABOUTME: Tests the compact handoff snapshot format and durable round trip.

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
				mode: "PLAN",
				tasks: [{ id: 1, text: "Run tests", status: "inprogress" }],
				children: [{ id: "scout-1", agent: "scout", status: "done", task: "Map files" }],
				nextAction: "Run the test suite",
				verification: { status: "UNVERIFIED", attempt: 0 },
			});
			writeHandoff(workspace, snapshot);
			expect(readHandoff(workspace)).toEqual(snapshot);
			expect(hasMeaningfulHandoff(snapshot)).toBe(true);
			expect(renderHandoff(snapshot)).toContain("Next action: Run the test suite");
			expect(renderHandoffPrompt(snapshot)).toContain("Resumable task handoff");
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

	it("restores a handoff at session start and persists progress on tool results", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "handoff-extension-"));
		const handlers = new Map<string, Function>();
		const notifications: string[] = [];
		let command: any;
		const pi = {
			registerCommand(_name: string, definition: any) { command = definition; },
			registerTool() {},
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
			const resumed = await handlers.get("before_agent_start")!({}, ctx);
			expect(resumed.systemPrompt).toContain("Resume this");
			(globalThis as any).__piTaskList = { tasks: [{ id: 1, text: "Continue", status: "inprogress" }] };
			await handlers.get("tool_result")!({ toolName: "tasks", result: { details: {} } }, ctx);
			await new Promise((resolve) => setTimeout(resolve, 550));
			expect(JSON.parse(readFileSync(handoffPath(workspace), "utf8")).tasks[0].text).toBe("Continue");
			await command.handler("clear", ctx);
			expect(readHandoff(workspace)).toBeUndefined();
			delete (globalThis as any).__piTaskList;
		} finally {
			await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
			delete (globalThis as any).__piTaskList;
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});
