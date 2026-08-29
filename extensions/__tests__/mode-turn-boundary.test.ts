// ABOUTME: Verifies that set_mode starts a fresh model turn with the new mode prompt.

import { describe, expect, it, vi } from "vitest";
import modeCycler from "../mode-cycler.ts";
import { setCoordinationMode } from "../lib/coordination-state.ts";
import { markPlanApproved, resetApprovals } from "../lib/approval-gate.ts";

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
});
