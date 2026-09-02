import { describe, expect, it } from "bun:test";
import tasksExtension, { decideGateClaim } from "../tasks.ts";
import { coordinationState, setCoordinationMode } from "../lib/coordination-state.ts";

describe("tasks gate decision", () => {
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

	it("allows an empty list in NORMAL so the agent can create its first task", () => {
		expect(decideGateClaim([])).toEqual({ block: false });
	});

	it("blocks an empty list in orchestration modes", () => {
		expect(decideGateClaim([], true)).toMatchObject({ block: true });
		expect(decideGateClaim([], true).reason).toContain("tasks new-list");
	});
});


describe("strict gate integration", () => {
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
		const previousStrict = process.env.PI_TASKS_STRICT;
		try {
			delete process.env.PI_TASKS_STRICT;
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
		} finally {
			if (previousStrict === undefined) delete process.env.PI_TASKS_STRICT;
			else process.env.PI_TASKS_STRICT = previousStrict;
		}
	});
});


describe("advisory gate opt-out", () => {
	it("warns without blocking ordinary tools when PI_TASKS_STRICT=0", async () => {
		let tool: any;
		const handlers = new Map<string, Function>();
		const pi = { registerTool(def: any) { tool = def; }, registerCommand() {}, on(name: string, handler: Function) { handlers.set(name, handler); }, sendMessage() {} };
		const ctx = { ui: { setStatus() {}, setWidget() {}, notify() {} } };
		const previousStrict = process.env.PI_TASKS_STRICT;
		try {
			process.env.PI_TASKS_STRICT = "0";
			tasksExtension(pi as any);
			await tool.execute("new-list", { action: "new-list", text: "small change" }, undefined, undefined, ctx);
			await tool.execute("add", { action: "add", text: "edit one file" }, undefined, undefined, ctx);
			const advisory = await handlers.get("tool_call")!({ toolName: "bash" }, ctx);
			expect(advisory.block).toBe(false);
			expect(advisory.reason).toContain("Task suggestion");
		} finally {
			if (previousStrict === undefined) delete process.env.PI_TASKS_STRICT;
			else process.env.PI_TASKS_STRICT = previousStrict;
		}
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


describe("mode-aware gate integration", () => {
	const requiredModes = ["PLAN", "SPEC", "PIPELINE", "TEAM", "CHAIN"] as const;

	it("hard-blocks empty task lists for every orchestration mode", async () => {
		const previous = coordinationState().mode;
		try {
			for (const mode of requiredModes) {
				const handlers = new Map<string, Function>();
				const pi = {
					registerTool() {}, registerCommand() {},
					on(name: string, handler: Function) { handlers.set(name, handler); },
					sendMessage() {},
				};
				const ctx = { ui: { setStatus() {}, setWidget() {}, notify() {} } };
				setCoordinationMode(mode);
				tasksExtension(pi as any);
				for (const toolName of ["bash", "dispatch_agent", "advance_phase"]) {
					const blocked = await handlers.get("tool_call")!({ toolName }, ctx);
					expect(blocked.block, `${mode} should gate ${toolName}`).toBe(true);
				}
			}
		} finally {
			setCoordinationMode(previous);
		}
	});

	it("allows delegated work after toggling a task active in every orchestration mode", async () => {
		const previous = coordinationState().mode;
		try {
			for (const mode of requiredModes) {
				let tool: any;
				const handlers = new Map<string, Function>();
				const pi = {
					registerTool(def: any) { tool = def; }, registerCommand() {},
					on(name: string, handler: Function) { handlers.set(name, handler); },
					sendMessage() {},
				};
				const ctx = { ui: { setStatus() {}, setWidget() {}, notify() {} } };
				setCoordinationMode(mode);
				tasksExtension(pi as any);
				await tool.execute("new-list", { action: "new-list", text: `${mode} work` }, undefined, undefined, ctx);
				await tool.execute("add", { action: "add", text: "perform work" }, undefined, undefined, ctx);
				const idle = await handlers.get("tool_call")!({ toolName: "dispatch_agent" }, ctx);
				expect(idle.block, `${mode} should gate idle tasks`).toBe(true);
				await tool.execute("toggle", { action: "toggle", id: 1 }, undefined, undefined, ctx);
				const active = await handlers.get("tool_call")!({ toolName: "dispatch_agent" }, ctx);
				expect(active.block, `${mode} should allow an active task`).toBe(false);
			}
		} finally {
			setCoordinationMode(previous);
		}
	});

	it("requires rebuilding an existing task list after entering a new orchestration mode", async () => {
		const previous = coordinationState().mode;
		try {
			const handlers = new Map<string, Function>();
			let tool: any;
			const pi = {
				registerTool(def: any) { tool = def; }, registerCommand() {},
				on(name: string, handler: Function) { handlers.set(name, handler); },
				sendMessage() {},
			};
			const ctx = { ui: { setStatus() {}, setWidget() {}, notify() {}, confirm: async () => true } };
			setCoordinationMode("NORMAL");
			tasksExtension(pi as any);
			await tool.execute("new-list", { action: "new-list", text: "old work" }, undefined, undefined, ctx);
			await tool.execute("add", { action: "add", text: "coarse old task" }, undefined, undefined, ctx);
			await tool.execute("toggle", { action: "toggle", id: 1 }, undefined, undefined, ctx);

			setCoordinationMode("SPEC");
			const beforeRefresh = await handlers.get("tool_call")!({ toolName: "dispatch_agent" }, ctx);
			expect(beforeRefresh.block).toBe(true);
			expect(beforeRefresh.reason).toContain("Rebuild it with `tasks new-list`");

			await tool.execute("new-list", { action: "new-list", text: "spec implementation" }, undefined, undefined, ctx);
			await tool.execute("add", { action: "add", text: "concrete spec step" }, undefined, undefined, ctx);
			await tool.execute("toggle", { action: "toggle", id: 1 }, undefined, undefined, ctx);
			const afterRefresh = await handlers.get("tool_call")!({ toolName: "dispatch_agent" }, ctx);
			expect(afterRefresh.block).toBe(false);
		} finally {
			setCoordinationMode(previous);
		}
	});

	it("allows scout subagent_create before a task exists", async () => {
		const previous = coordinationState().mode;
		try {
			const handlers = new Map<string, Function>();
			const pi = {
				registerTool() {}, registerCommand() {},
				on(name: string, handler: Function) { handlers.set(name, handler); },
				sendMessage() {},
			};
			const ctx = { ui: { setStatus() {}, setWidget() {}, notify() {} } };
			setCoordinationMode("PLAN");
			tasksExtension(pi as any);
			const scout = await handlers.get("tool_call")!({ toolName: "subagent_create", arguments: { name: "scout", task: "map auth" } }, ctx);
			expect(scout.block).toBe(false);
			const builder = await handlers.get("tool_call")!({ toolName: "subagent_create", arguments: { name: "builder", task: "edit files" } }, ctx);
			expect(builder.block).toBe(true);
		} finally {
			setCoordinationMode(previous);
		}
	});

	it("allows researcher reconnaissance before a task exists", async () => {
		const previous = coordinationState().mode;
		try {
			const handlers = new Map<string, Function>();
			const pi = {
				registerTool() {}, registerCommand() {},
				on(name: string, handler: Function) { handlers.set(name, handler); },
				sendMessage() {},
			};
			setCoordinationMode("PLAN");
			tasksExtension(pi as any);
			const researcher = await handlers.get("tool_call")!({ toolName: "subagent_create", arguments: { name: "researcher", task: "check current API docs" } }, {});
			expect(researcher.block).toBe(false);
		} finally {
			setCoordinationMode(previous);
		}
	});

	it("keeps an empty NORMAL list advisory", async () => {
		const previous = coordinationState().mode;
		try {
			const handlers = new Map<string, Function>();
			const pi = {
				registerTool() {}, registerCommand() {},
				on(name: string, handler: Function) { handlers.set(name, handler); },
				sendMessage() {},
			};
			const ctx = { ui: { setStatus() {}, setWidget() {}, notify() {} } };
			setCoordinationMode("NORMAL");
			tasksExtension(pi as any);
			const advisory = await handlers.get("tool_call")!({ toolName: "bash" }, ctx);
			expect(advisory.block).toBe(false);
			expect(advisory.reason).toBeUndefined();
		} finally {
			setCoordinationMode(previous);
		}
	});
});
