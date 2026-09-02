// ABOUTME: Verifies that set_mode starts a fresh model turn with the new mode prompt.

import { describe, expect, it, vi } from "vitest";
import modeCycler from "../mode-cycler.ts";
import { coordinationState, setCoordinationMode } from "../lib/coordination-state.ts";
import { markPlanApproved, resetApprovals } from "../lib/approval-gate.ts";
import { NORMAL_RECON_LIMIT } from "../lib/normal-escalation.ts";

function registerModeTool() {
	let tool: any;
	const handlers: Record<string, (event: any, ctx?: any) => any> = {};
	const pi: any = {
		registerTool(def: any) { tool = def; },
		registerCommand() {},
		registerShortcut() {},
		on(event: string, handler: (event: any, ctx?: any) => any) { handlers[event] = handler; },
		sendUserMessage: vi.fn(),
	};
	modeCycler(pi);
	return { tool, pi, handlers };
}

describe("set_mode turn boundary", () => {
	it("does not abort or inject a Continue-in-MODE user turn", async () => {
		const { tool, pi } = registerModeTool();
		const abort = vi.fn();
		const ctx: any = { abort };

		const result = await tool.execute("mode-1", { mode: "PLAN", reason: "multi-file change" }, undefined, undefined, ctx);
		await Promise.resolve();

		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		expect(abort).not.toHaveBeenCalled();
		expect(result.content[0].text).toContain("Mode set to PLAN");
		expect(result.content[0].text).toContain("Scout if you cannot name the files to change");
	});

	it("rewrites the next provider payload to the new mode prompt", async () => {
		const { tool, handlers } = registerModeTool();
		await tool.execute("mode-1", { mode: "PLAN" }, undefined, undefined, { abort: vi.fn() });

		const rewritten = await handlers.before_provider_request({
			type: "before_provider_request",
			payload: { messages: [{ role: "system", content: "NORMAL leftover" }, { role: "user", content: "hi" }] },
		});
		expect(rewritten.messages[0].content).toContain("You are in PLAN mode");
		expect(rewritten.messages[1].content).toBe("hi");
	});

	it("blocks PLAN implementation writes until show_plan is approved", async () => {
		const toolCallHandlers: Array<(event: any, ctx?: any) => any> = [];
		const pi: any = {
			registerTool() {},
			registerCommand() {},
			registerShortcut() {},
			on(event: string, handler: (event: any, ctx?: any) => any) {
				if (event === "tool_call") toolCallHandlers.push(handler);
			},
			getActiveTools: () => [],
			setActiveTools() {},
			sendUserMessage: vi.fn(),
		};
		modeCycler(pi);
		resetApprovals();
		setCoordinationMode("PLAN");

		const ctx = { cwd: "/tmp/app" };
		const blocked = await Promise.all(toolCallHandlers.map((h) => h({ toolName: "write", arguments: { path: "src/a.ts" } }, ctx)));
		expect(blocked.some((r) => r?.block === true)).toBe(true);

		const viaCallTool = await Promise.all(toolCallHandlers.map((h) => h({
			toolName: "call_tool",
			arguments: { tool_name: "write", arguments: { path: "src/a.ts", content: "x" } },
		}, ctx)));
		expect(viaCallTool.some((r) => r?.block === true)).toBe(true);

		const planWrite = await Promise.all(toolCallHandlers.map((h) => h({ toolName: "write", arguments: { path: ".context/todo.md" } }, ctx)));
		expect(planWrite.every((r) => !r || r.block === false)).toBe(true);

		markPlanApproved();
		const after = await Promise.all(toolCallHandlers.map((h) => h({ toolName: "write", arguments: { path: "src/a.ts" } }, ctx)));
		expect(after.every((r) => !r || r.block === false)).toBe(true);
	});

	it("does not create a second turn when the mode is unchanged", async () => {
		const { tool, pi, handlers } = registerModeTool();
		const abort = vi.fn();
		await tool.execute("mode-2", { mode: "NORMAL" }, undefined, undefined, { abort });
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		expect(abort).not.toHaveBeenCalled();
		expect(await handlers.before_provider_request({
			type: "before_provider_request",
			payload: { system: "keep" },
		})).toBeUndefined();
	});

	it("interrupts a NORMAL read-only loop and releases it after scout dispatch", async () => {
		const toolCallHandlers: Array<(event: any, ctx?: any) => any> = [];
		const pi: any = {
			registerTool() {},
			registerCommand() {},
			registerShortcut() {},
			on(event: string, handler: (event: any, ctx?: any) => any) {
				if (event === "tool_call") toolCallHandlers.push(handler);
			},
		};
		modeCycler(pi);

		for (let i = 0; i < NORMAL_RECON_LIMIT - 1; i++) {
			const result = await Promise.all(toolCallHandlers.map((h) => h({ toolName: "bash", arguments: { command: "rg -n TODO ." } }, {})));
			expect(result.every((r) => !r || r.block !== true)).toBe(true);
		}
		const blocked = await Promise.all(toolCallHandlers.map((h) => h({ toolName: "bash", arguments: { command: "find . -type f" } }, {})));
		expect(blocked.some((r) => r?.block === true)).toBe(true);

		const scout = await Promise.all(toolCallHandlers.map((h) => h({ toolName: "subagent_create", arguments: { name: "scout", task: "map" } }, {})));
		expect(scout.every((r) => !r || r.block !== true)).toBe(true);
		const released = await Promise.all(toolCallHandlers.map((h) => h({ toolName: "read", arguments: { path: "README.md" } }, {})));
		expect(released.every((r) => !r || r.block !== true)).toBe(true);
	});

	it("starts a fresh NORMAL scout decision for a follow-up user message", async () => {
		const { handlers } = registerModeTool();
		for (let i = 0; i < NORMAL_RECON_LIMIT - 1; i++) {
			await handlers.tool_call({ toolName: "read", arguments: { path: "x" } }, {});
		}
		await handlers.input({ type: "input", source: "interactive", text: "follow-up" }, {});
		const firstFollowUpRead = await handlers.tool_call({ toolName: "read", arguments: { path: "x" } }, {});
		expect(firstFollowUpRead?.block).not.toBe(true);
		expect(firstFollowUpRead?.reason).toBeUndefined();
	});

	it("resets NORMAL escalation and pending prompt rewrites on session switch", async () => {
		const toolCallHandlers: Array<(event: any, ctx?: any) => any> = [];
		const handlers: Record<string, any> = {};
		const tools: Record<string, any> = {};
		const pi: any = {
			registerTool(def: any) { tools[def.name] = def; },
			registerCommand() {},
			registerShortcut() {},
			on(event: string, handler: (event: any, ctx?: any) => any) {
				if (event === "tool_call") toolCallHandlers.push(handler);
				else handlers[event] = handler;
			},
		};
		modeCycler(pi);

		for (let i = 0; i < 6; i++) await Promise.all(toolCallHandlers.map((h) => h({ toolName: "read", arguments: { path: "x" } }, {})));
		await handlers.session_switch({}, { hasUI: false });
		const released = await Promise.all(toolCallHandlers.map((h) => h({ toolName: "read", arguments: { path: "x" } }, {})));
		expect(released.every((r) => !r || r.block !== true)).toBe(true);

		await tools.set_mode.execute("mode-1", { mode: "PLAN" }, undefined, undefined, { abort: vi.fn(), hasUI: false });
		markPlanApproved();
		const replacementCtx: any = { hasUI: true, ui: { setStatus: vi.fn(), setWidget: vi.fn() } };
		await handlers.session_switch({}, replacementCtx);
		expect(coordinationState().mode).toBe("NORMAL");
		expect(coordinationState().planApproved).toBe(false);
		expect(replacementCtx.ui.setStatus).toHaveBeenCalledWith("mode", "");
		const providerResult = await handlers.before_provider_request({
			type: "before_provider_request",
			payload: { messages: [{ role: "system", content: "NORMAL current" }] },
		});
		expect(providerResult).toBeUndefined();
	});
});
