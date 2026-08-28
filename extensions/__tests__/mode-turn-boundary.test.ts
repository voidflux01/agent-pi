// ABOUTME: Verifies that set_mode starts a fresh model turn with the new mode prompt.

import { describe, expect, it, vi } from "vitest";
import modeCycler from "../mode-cycler.ts";

function registerModeTool() {
	let tool: any;
	const pi: any = {
		registerTool(def: any) { tool = def; },
		registerCommand() {},
		registerShortcut() {},
		on() {},
		sendUserMessage: vi.fn(),
	};
	modeCycler(pi);
	return { tool, pi };
}

describe("set_mode turn boundary", () => {
	it("queues a follow-up and aborts the stale prompt turn", async () => {
		const { tool, pi } = registerModeTool();
		const abort = vi.fn();
		const ctx: any = { abort };

		await tool.execute("mode-1", { mode: "PLAN", reason: "multi-file change" }, undefined, undefined, ctx);

		expect(pi.sendUserMessage).toHaveBeenCalledWith(
			"Continue the task in PLAN mode.",
			{ deliverAs: "followUp" },
		);
		expect(abort).toHaveBeenCalledTimes(1);
	});

	it("does not create a second turn when the mode is unchanged", async () => {
		const { tool, pi } = registerModeTool();
		const abort = vi.fn();
		await tool.execute("mode-2", { mode: "NORMAL" }, undefined, undefined, { abort });
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		expect(abort).not.toHaveBeenCalled();
	});
});
