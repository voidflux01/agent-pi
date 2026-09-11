// ABOUTME: Verifies that set_mode starts a fresh model turn with the new mode prompt.

import { describe, expect, it, vi } from "vitest";
import modeCycler from "../mode-cycler.ts";
import { coordinationState, setCoordinationMode } from "../lib/coordination-state.ts";
import { markPlanApproved, markSpecApproved, resetApprovals } from "../lib/approval-gate.ts";
import { NORMAL_RECON_LIMIT, NORMAL_RECON_BLOCK_LIMIT } from "../lib/normal-escalation.ts";

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
		const blocked = await Promise.all(toolCallHandlers.map((h) => h({ toolName: "write", input: { path: "src/a.ts" } }, ctx)));
		expect(blocked.some((r) => r?.block === true)).toBe(true);

		const viaCallTool = await Promise.all(toolCallHandlers.map((h) => h({
			toolName: "call_tool",
			input: { tool_name: "write", input: { path: "src/a.ts", content: "x" } },
		}, ctx)));
		expect(viaCallTool.some((r) => r?.block === true)).toBe(true);

		const planWrite = await Promise.all(toolCallHandlers.map((h) => h({ toolName: "write", input: { path: ".context/todo.md" } }, ctx)));
		expect(planWrite.every((r) => !r || r.block === false)).toBe(true);

		markPlanApproved();
		const after = await Promise.all(toolCallHandlers.map((h) => h({ toolName: "write", input: { path: "src/a.ts" } }, ctx)));
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

		for (let i = 0; i < NORMAL_RECON_BLOCK_LIMIT - 1; i++) {
			const result = await Promise.all(toolCallHandlers.map((h) => h({ toolName: "bash", input: { command: "rg -n TODO ." } }, {})));
			expect(result.every((r) => !r || r.block !== true)).toBe(true);
		}
		const blocked = await Promise.all(toolCallHandlers.map((h) => h({ toolName: "bash", input: { command: "rg -n TODO ." } }, {})));
		expect(blocked.some((r) => r?.block === true)).toBe(true);

		const scout = await Promise.all(toolCallHandlers.map((h) => h({ toolName: "subagent_create", input: { name: "scout", task: "map" } }, {})));
		expect(scout.every((r) => !r || r.block !== true)).toBe(true);
		const released = await Promise.all(toolCallHandlers.map((h) => h({ toolName: "read", input: { path: "README.md" } }, {})));
		expect(released.every((r) => !r || r.block !== true)).toBe(true);
	});

	it("interrupts a PLAN/SPEC read-only loop and releases it after a fresh scout", async () => {
		const toolCallHandlers: Array<(event: any, ctx?: any) => any> = [];
		const modeTools: any[] = [];
		const pi: any = {
			registerTool(def: any) { modeTools.push(def); },
			registerCommand() {},
			registerShortcut() {},
			on(event: string, handler: (event: any, ctx?: any) => any) {
				if (event === "tool_call") toolCallHandlers.push(handler);
			},
		};
		modeCycler(pi);

		for (const mode of ["PLAN", "SPEC"]) {
			await modeTools[0].execute("mode-recon", { mode }, undefined, undefined, { abort: vi.fn() });
			for (let i = 0; i < NORMAL_RECON_BLOCK_LIMIT - 1; i++) {
				const result = await Promise.all(toolCallHandlers.map((h) => h({ toolName: "read", input: { path: "src/a.ts" } }, {})));
				expect(result.every((r) => !r || r.block !== true)).toBe(true);
			}
			const blocked = await Promise.all(toolCallHandlers.map((h) => h({ toolName: "read", input: { path: "src/a.ts" } }, {})));
			expect(blocked.some((r) => r?.block === true)).toBe(true);

			const scout = await Promise.all(toolCallHandlers.map((h) => h({ toolName: "subagent_create", input: { name: "scout", task: "re-check the unresolved question" } }, {})));
			expect(scout.every((r) => !r || r.block !== true)).toBe(true);
			const released = await Promise.all(toolCallHandlers.map((h) => h({ toolName: "read", input: { path: "src/a.ts" } }, {})));
			expect(released.every((r) => !r || r.block !== true)).toBe(true);
		}
	});

	it("does not escalate reads after SPEC approval", async () => {
		const toolCallHandlers: Array<(event: any, ctx?: any) => any> = [];
		const modeTools: any[] = [];
		const pi: any = {
			registerTool(def: any) { modeTools.push(def); },
			registerCommand() {},
			registerShortcut() {},
			on(event: string, handler: (event: any, ctx?: any) => any) {
				if (event === "tool_call") toolCallHandlers.push(handler);
			},
		};
		modeCycler(pi);
		await modeTools[0].execute("mode-approved-recon", { mode: "SPEC" }, undefined, undefined, { abort: vi.fn() });
		markSpecApproved();

		for (let i = 0; i < NORMAL_RECON_LIMIT * 2; i++) {
			const result = await Promise.all(toolCallHandlers.map((h) => h({ toolName: "read", input: { path: "src/a.ts" } }, {})));
			expect(result.every((r) => !r || r.block !== true)).toBe(true);
		}
	});

	it("starts a fresh NORMAL scout decision for a follow-up user message", async () => {
		const { handlers } = registerModeTool();
		for (let i = 0; i < NORMAL_RECON_LIMIT - 1; i++) {
			await handlers.tool_call({ toolName: "read", input: { path: "x" } }, {});
		}
		await handlers.input({ type: "input", source: "interactive", text: "follow-up" }, {});
		const firstFollowUpRead = await handlers.tool_call({ toolName: "read", input: { path: "x" } }, {});
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

		for (let i = 0; i < 6; i++) await Promise.all(toolCallHandlers.map((h) => h({ toolName: "read", input: { path: "x" } }, {})));
		await handlers.session_before_switch({}, { hasUI: false });
		const released = await Promise.all(toolCallHandlers.map((h) => h({ toolName: "read", input: { path: "x" } }, {})));
		expect(released.every((r) => !r || r.block !== true)).toBe(true);

		await tools.set_mode.execute("mode-1", { mode: "PLAN" }, undefined, undefined, { abort: vi.fn(), hasUI: false });
		markPlanApproved();
		const replacementCtx: any = { hasUI: true, ui: { setStatus: vi.fn(), setWidget: vi.fn() } };
		await handlers.session_before_switch({}, replacementCtx);
		expect(coordinationState().mode).toBe("NORMAL");
		expect(coordinationState().planApproved).toBe(false);
		expect(replacementCtx.ui.setStatus).toHaveBeenCalledWith("mode", "");
		const providerResult = await handlers.before_provider_request({
			type: "before_provider_request",
			payload: { messages: [{ role: "system", content: "NORMAL current" }] },
		});
		expect(providerResult).toBeUndefined();
	});

	it("delivers the soft recon advisory once, on the reconnaissance result it was raised for", async () => {
		// Fresh module instance: the advisory queue is module state.
		vi.resetModules();
		const { default: freshModeCycler } = await import("../mode-cycler.ts");
		const toolCallHandlers: Array<(event: any, ctx?: any) => any> = [];
		const toolResultHandlers: Array<(event: any, ctx?: any) => any> = [];
		const pi: any = {
			registerTool() {},
			registerCommand() {},
			registerShortcut() {},
			on(event: string, handler: (event: any, ctx?: any) => any) {
				if (event === "tool_call") toolCallHandlers.push(handler);
				if (event === "tool_result") toolResultHandlers.push(handler);
			},
			getActiveTools: () => [],
			setActiveTools() {},
			sendUserMessage: vi.fn(),
		};
		freshModeCycler(pi);
		resetApprovals();
		setCoordinationMode("NORMAL");

		for (let i = 0; i < NORMAL_RECON_LIMIT - 1; i++) {
			const below = await Promise.all(toolCallHandlers.map((h) => h({ toolName: "grep", input: { query: `term-${i}` } }, {})));
			expect(below.every((r) => !r || r.block !== true)).toBe(true);
		}
		const triggering = await Promise.all(toolCallHandlers.map((h) => h({ toolName: "grep", input: { query: "term-final" } }, {})));
		expect(triggering.every((r) => !r || r.block !== true)).toBe(true);

		const content = [{ type: "text", text: "match" }];
		const injected = (await Promise.all(toolResultHandlers.map((h) => h({ toolName: "grep", input: { query: "term-final" }, content, isError: false }, {}))))
			.filter((r) => JSON.stringify(r?.content ?? "").includes("advisory"));
		expect(injected).toHaveLength(1);
		// The reminder is appended, never a replacement of the real result.
		expect(injected[0].content[0]).toEqual(content[0]);
		expect(injected[0].content[1].text).toContain("scout");

		const later = await Promise.all(toolResultHandlers.map((h) => h({ toolName: "grep", input: { query: "term-final" }, content, isError: false }, {})));
		expect(later.every((r) => !JSON.stringify(r?.content ?? "").includes("advisory"))).toBe(true);
	});

	it("lowers the advisory threshold for the next burst after a scout pick", async () => {
		const { handlers } = registerModeTool();
		const advisoryOnResult = async (): Promise<boolean> => {
			const r = await handlers.tool_result({ toolName: "read", content: [{ type: "text", text: "m" }], isError: false }, {});
			return JSON.stringify(r?.content ?? "").includes("advisory");
		};

		// Burst 1: advisory fires at 4 reads, model picks a scout → soften 4 → 3.
		for (let i = 0; i < NORMAL_RECON_LIMIT - 1; i++) await handlers.tool_call({ toolName: "read", input: { path: `a${i}` } }, {});
		await handlers.tool_call({ toolName: "read", input: { path: "a3" } }, {});
		expect(await advisoryOnResult()).toBe(true);
		await handlers.tool_call({ toolName: "subagent_create", input: { name: "scout", task: "map" } }, {});
		// The parent acts on the scout's report → resolved; the soften stays.
		await handlers.tool_call({ toolName: "write", input: { path: "src/x.ts", content: "x" } }, {});

		// Burst 2: the advisory now arrives one read earlier (soft = 3).
		await handlers.tool_call({ toolName: "read", input: { path: "b0" } }, {});
		expect(await advisoryOnResult()).toBe(false);
		await handlers.tool_call({ toolName: "read", input: { path: "b1" } }, {});
		expect(await advisoryOnResult()).toBe(false);
		await handlers.tool_call({ toolName: "read", input: { path: "b2" } }, {});
		expect(await advisoryOnResult()).toBe(true);
	});

	it("raises the advisory threshold after the model acts without a scout", async () => {
		const { handlers } = registerModeTool();
		const advisoryOnResult = async (): Promise<boolean> => {
			const r = await handlers.tool_result({ toolName: "read", content: [{ type: "text", text: "m" }], isError: false }, {});
			return JSON.stringify(r?.content ?? "").includes("advisory");
		};

		// Burst 1: advisory at 4, model proceeds directly → harden 4 → 5.
		for (let i = 0; i < NORMAL_RECON_LIMIT - 1; i++) await handlers.tool_call({ toolName: "read", input: { path: `a${i}` } }, {});
		await handlers.tool_call({ toolName: "read", input: { path: "a3" } }, {});
		expect(await advisoryOnResult()).toBe(true);
		await handlers.tool_call({ toolName: "write", input: { path: "src/a.ts", content: "x" } }, {});

		// Burst 2: advisory waits until the 5th read (soft = 5).
		let firedAt = -1;
		for (let i = 0; i < 5; i++) {
			await handlers.tool_call({ toolName: "read", input: { path: `b${i}` } }, {});
			if (await advisoryOnResult()) firedAt = i;
		}
		expect(firedAt).toBe(4);
	});

	it("stall tightens both thresholds after a hard block", async () => {
		const { handlers } = registerModeTool();
		const advisoryOnResult = async (): Promise<boolean> => {
			const r = await handlers.tool_result({ toolName: "read", content: [{ type: "text", text: "m" }], isError: false }, {});
			return JSON.stringify(r?.content ?? "").includes("advisory");
		};

		// Burst 1: advisory fires at 4, then 8 consecutive reads block → stall: soft 4 → 3, block 8 → 7.
		let blockedCall: any = null;
		for (let i = 0; i < NORMAL_RECON_BLOCK_LIMIT; i++) {
			blockedCall = await handlers.tool_call({ toolName: "read", input: { path: `a${i}` } }, {});
			if (i === NORMAL_RECON_LIMIT - 1) {
				expect(await advisoryOnResult()).toBe(true); // drain the advisory queued at the soft threshold
			}
		}
		expect(blockedCall?.block).toBe(true);
		await handlers.tool_call({ toolName: "write", input: { path: "src/a.ts", content: "x" } }, {});

		// Burst 2: advisory fires at 3 (soft = 3), block fires at 7 (block = 7).
		let firedAt = -1;
		let reblockAt = -1;
		for (let i = 0; i < 7; i++) {
			const r: any = await handlers.tool_call({ toolName: "read", input: { path: `b${i}` } }, {});
			if (r?.block === true) reblockAt = i;
			if ((await advisoryOnResult()) && firedAt === -1) firedAt = i;
		}
		expect(firedAt).toBe(2);
		expect(reblockAt).toBe(6);
	});

	it("reverts the softened threshold when a scout is followed by re-exploration", async () => {
		const { handlers } = registerModeTool();
		const advisoryOnResult = async (): Promise<boolean> => {
			const r = await handlers.tool_result({ toolName: "read", content: [{ type: "text", text: "m" }], isError: false }, {});
			return JSON.stringify(r?.content ?? "").includes("advisory");
		};

		// Burst 1: advisory at 4, scout pick → soften 4 → 3.
		for (let i = 0; i < NORMAL_RECON_LIMIT - 1; i++) await handlers.tool_call({ toolName: "read", input: { path: `a${i}` } }, {});
		await handlers.tool_call({ toolName: "read", input: { path: "a3" } }, {});
		expect(await advisoryOnResult()).toBe(true);
		await handlers.tool_call({ toolName: "subagent_create", input: { name: "scout", task: "map" } }, {});

		// Burst 2: the parent ignores the scout and re-explores to the lowered
		// threshold (3) → the advisory fires again and the soften is undone (3 → 4).
		await handlers.tool_call({ toolName: "read", input: { path: "b0" } }, {});
		await handlers.tool_call({ toolName: "read", input: { path: "b1" } }, {});
		await handlers.tool_call({ toolName: "read", input: { path: "b2" } }, {});
		expect(await advisoryOnResult()).toBe(true);

		// A fresh request resets the burst; the threshold is back at 4.
		await handlers.input({ type: "input", source: "interactive", text: "next request" }, {});
		await handlers.tool_call({ toolName: "read", input: { path: "c0" } }, {});
		await handlers.tool_call({ toolName: "read", input: { path: "c1" } }, {});
		await handlers.tool_call({ toolName: "read", input: { path: "c2" } }, {});
		expect(await advisoryOnResult()).toBe(false);
		await handlers.tool_call({ toolName: "read", input: { path: "c3" } }, {});
		expect(await advisoryOnResult()).toBe(true);
	});
});
