// ABOUTME: Guards the walk-through bugs: grill ctx, default-off grill, mode abort.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const extDir = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("grill tools bind the execute context", () => {
	const src = readFileSync(join(extDir, "plan-viewer.ts"), "utf8");

	it("does not read a missing ctx.cwd from grill handlers", () => {
		expect(src).toContain("recordGrillTurn(ctx2.cwd");
		expect(src).toContain("saveGrillResults(ctx2.cwd");
		expect(src).toContain("armGrillSession(ctx2.cwd");
		expect(src).not.toMatch(/recordGrillTurn\(ctx\.cwd/);
		expect(src).not.toMatch(/saveGrillResults\(ctx\.cwd/);
	});

	it("does not auto-arm grill-me on show_plan", () => {
		expect(src).toContain("params.grill === true");
		expect(src).not.toContain("params.grill !== false");
	});

	it("does not tell the model to implement while grill is unfinished", () => {
		expect(src).toContain("Do not implement yet.");
	});

	it("treats questions Submit Answers as submitted even if the POST action is submitted", () => {
		expect(src).toContain('result.action === "approved" || result.action === "submitted"');
	});
});

describe("viewer tools do not queue a second approval turn", () => {
	const planSrc = readFileSync(join(extDir, "plan-viewer.ts"), "utf8");
	const specSrc = readFileSync(join(extDir, "spec-viewer.ts"), "utf8");

	function sliceToolThenCommand(src: string, commandName: string): { tool: string; command: string } {
		const commandIdx = src.indexOf(`pi.registerCommand("${commandName}"`);
		expect(commandIdx).toBeGreaterThan(0);
		return { tool: src.slice(0, commandIdx), command: src.slice(commandIdx) };
	}

	it("show_plan returns the approval in the tool result, not a follow-up", () => {
		const { tool, command } = sliceToolThenCommand(planSrc, "plan");
		expect(tool).not.toContain('customType: "plan-approved"');
		expect(tool).not.toContain('customType: "plan-viewer-answers"');
		expect(tool).toContain("Proceed with implementation.");
		expect(tool).toContain("The updated plan has been saved to");
		expect(command).toContain('customType: "plan-approved"');
		expect(command).toContain('deliverAs: "followUp"');
	});

	it("show_spec returns the approval in the tool result, not a follow-up", () => {
		const { tool, command } = sliceToolThenCommand(specSrc, "spec");
		expect(tool).not.toContain('customType: "spec-approved"');
		expect(tool).not.toContain('customType: "spec-changes-requested"');
		expect(tool).toContain("Proceed with implementation.");
		expect(command).toContain('customType: "spec-approved"');
		expect(command).toContain('deliverAs: "followUp"');
	});
});
