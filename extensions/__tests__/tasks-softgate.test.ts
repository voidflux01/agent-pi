import { describe, expect, it } from "bun:test";
import tasksExtension, { decideGateClaim } from "../tasks.ts";

describe("tasks gate decision (hard gate)", () => {
	it("blocks when tasks exist but none is in progress", () => {
		const d = decideGateClaim([
			{ id: 1, status: "done" },
			{ id: 2, status: "idle" },
			{ id: 3, status: "idle" },
		]);
		expect(d.block).toBe(true);
		expect(d.reason).toContain("tasks toggle");
	});

	it("does not mutate task state implicitly", () => {
		const tasks = [{ id: 1, status: "idle" }];
		decideGateClaim(tasks);
		expect(tasks).toEqual([{ id: 1, status: "idle" }]);
	});

	it("allows work when a task is already in progress", () => {
		expect(decideGateClaim([
			{ id: 1, status: "inprogress" },
			{ id: 2, status: "idle" },
		])).toEqual({ block: false });
	});

	it("blocks after all tasks are done until a new list is created", () => {
		const d = decideGateClaim([{ id: 1, status: "done" }]);
		expect(d.block).toBe(true);
		expect(d.reason).toContain("new-list");
	});

	it("allows an empty list so the agent can create its first task", () => {
		expect(decideGateClaim([])).toEqual({ block: false });
	});
});


describe("hard gate integration", () => {
	it("requires transcript-backed toggles before write tools", async () => {
		let tool: any;
		const handlers = new Map<string, Function>();
		const pi = {
			registerTool(def: any) { tool = def; },
			registerCommand() {},
			on(name: string, handler: Function) { handlers.set(name, handler); },
			sendMessage() {},
		};
		const ctx = { ui: { setStatus() {}, setWidget() {}, notify() {} } };
		tasksExtension(pi as any);

		await tool.execute("new-list", { action: "new-list", text: "tracked work" }, undefined, undefined, ctx);
		await tool.execute("add", { action: "add", text: "make the change" }, undefined, undefined, ctx);
		const blocked = await handlers.get("tool_call")!({ toolName: "bash" }, ctx);
		expect(blocked.block).toBe(true);

		const active = await tool.execute("toggle", { action: "toggle", id: 1 }, undefined, undefined, ctx);
		expect(active.details.tasks[0].status).toBe("inprogress");
		expect((await handlers.get("tool_call")!({ toolName: "bash" }, ctx)).block).toBe(false);

		const done = await tool.execute("toggle", { action: "toggle", id: 1 }, undefined, undefined, ctx);
		expect(done.details.tasks[0].status).toBe("done");
		expect((await handlers.get("tool_call")!({ toolName: "bash" }, ctx)).block).toBe(true);
	});
});


describe("transcript-backed reconstruction", () => {
	it("restores the gate from the last tasks tool result without auto-claiming", async () => {
		const handlers = new Map<string, Function>();
		const pi = {
			registerTool() {}, registerCommand() {},
			on(name: string, handler: Function) { handlers.set(name, handler); },
			sendMessage() {},
		};
		const ctx: any = {
			ui: { setStatus() {}, setWidget() {}, notify() {} },
			sessionManager: { getBranch: () => [{ type: "message", message: { role: "toolResult", toolName: "tasks", details: { action: "add", tasks: [{ id: 1, text: "resume", status: "idle" }], nextId: 2 } } }] },
		};
		tasksExtension(pi as any);
		await handlers.get("session_start")!(undefined, ctx);
		expect((await handlers.get("tool_call")!({ toolName: "bash" }, ctx)).block).toBe(true);
	});

	it("ignores malformed reconstructed task details", async () => {
		const handlers = new Map<string, Function>();
		const pi = { registerTool() {}, registerCommand() {}, on(name: string, handler: Function) { handlers.set(name, handler); }, sendMessage() {} };
		const ctx: any = { ui: { setStatus() {}, setWidget() {}, notify() {} }, sessionManager: { getBranch: () => [{ type: "message", message: { role: "toolResult", toolName: "tasks", details: { tasks: {}, nextId: "bad" } } }] } };
		tasksExtension(pi as any);
		await expect(handlers.get("session_start")!(undefined, ctx)).resolves.toBeUndefined();
		expect((await handlers.get("tool_call")!({ toolName: "bash" }, ctx)).block).toBe(false);
	});
});
