import { describe, expect, test } from "bun:test";
import { decideAutoAdvance } from "../pipeline-team.ts";

// D21 auto_advance decision — guards that the after-hook only advances on the
// narrow single-agent opt-in success case (regression for the cycle-15 stall
// where the model never advanced after a finished worker).
const base = {
	agentCount: 1,
	status: "done",
	isCurrent: true,
	isLast: false,
	phaseName: "build",
	output: "## RESULT success",
};

describe("decideAutoAdvance", () => {
	test("advances on opt-in single-agent success mid-pipeline", () => {
		expect(decideAutoAdvance({ ...base, autoAdvance: true })).toBe(true);
	});
	test("never without opt-in auto_advance", () => {
		expect(decideAutoAdvance({ ...base, autoAdvance: false })).toBe(false);
		expect(decideAutoAdvance({ ...base, autoAdvance: undefined })).toBe(false);
	});
	test("never for multi-agent or non-done or non-current or last phase", () => {
		expect(decideAutoAdvance({ ...base, autoAdvance: true, agentCount: 2 })).toBe(false);
		expect(decideAutoAdvance({ ...base, autoAdvance: true, status: "running" })).toBe(false);
		expect(decideAutoAdvance({ ...base, autoAdvance: true, isCurrent: false })).toBe(false);
		expect(decideAutoAdvance({ ...base, autoAdvance: true, isLast: true })).toBe(false);
	});
	test("review phase only advances on APPROVED", () => {
		const rev = { ...base, autoAdvance: true, phaseName: "review" };
		expect(decideAutoAdvance({ ...rev, output: "## RESULT NEEDS CHANGES" })).toBe(false);
		expect(decideAutoAdvance({ ...rev, output: "## RESULT APPROVED" })).toBe(true);
	});
	test("non-review phase advances regardless of output content", () => {
		expect(decideAutoAdvance({ ...base, autoAdvance: true, output: "## RESULT partial" })).toBe(true);
	});
});
