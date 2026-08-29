// ABOUTME: Guards the walk-through bugs: grill ctx, default-off grill, mode abort.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const extDir = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("grill-me is a prompt, not extra tools", () => {
	const src = readFileSync(join(extDir, "plan-viewer.ts"), "utf8");

	it("does not register grill tools or commands", () => {
		expect(src).not.toContain("grill_record_turn");
		expect(src).not.toContain("grill_save_results");
		expect(src).not.toContain("armGrillSession");
		expect(src).not.toContain("registerCommand(\"grill-me\"");
		expect(src).not.toContain("GRILL_ME_START");
		expect(src).not.toContain("params.grill");
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
		expect(tool).toContain("refresh the task list");
		expect(tool).toContain("The updated plan has been saved to");
		expect(tool).toContain("markPlanApproved()");
		expect(tool).toContain('if (purpose === "plan") resetApprovalForMode("PLAN")');
		expect(command).toContain('customType: "plan-approved"');
		expect(command).toContain('deliverAs: "followUp"');
		expect(command).toContain("markPlanApproved()");
		expect(command).toContain('resetApprovalForMode("PLAN")');
	});

	it("show_spec returns the approval in the tool result, not a follow-up", () => {
		const { tool, command } = sliceToolThenCommand(specSrc, "spec");
		expect(tool).not.toContain('customType: "spec-approved"');
		expect(tool).not.toContain('customType: "spec-changes-requested"');
		expect(tool).toContain("Proceed with implementation.");
		expect(tool).toContain("markSpecApproved()");
		expect(tool).toContain("refresh the task list");
		expect(tool).toContain('resetApprovalForMode("SPEC")');
		expect(command).toContain('customType: "spec-approved"');
		expect(command).toContain('deliverAs: "followUp"');
		expect(command).toContain("markSpecApproved()");
		expect(command).toContain('resetApprovalForMode("SPEC")');
	});
});
