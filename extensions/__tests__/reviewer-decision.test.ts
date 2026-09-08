import { describe, expect, it } from "vitest";
import { reviewerDecision } from "../lib/reviewer-decision.ts";

describe("reviewer decision gate", () => {
	it("requires explicit approval in the RESULT summary", () => {
		expect(reviewerDecision("## RESULT\nsummary: APPROVED — no blocking issues\n## END")).toBe("APPROVED");
		expect(reviewerDecision("## RESULT\nsummary: NEEDS CHANGES — fix the retry race\n## END")).toBe("NEEDS CHANGES");
	});

	it("fails closed for missing or ambiguous decisions", () => {
		expect(reviewerDecision("## RESULT\nsummary: review completed\n## END")).toBe("UNKNOWN");
		expect(reviewerDecision("review says APPROVED outside the result block")).toBe("UNKNOWN");
	});
});

// D13-real: verdict buried in prose still counts; negations and NEVER-approved never do.
it("reads APPROVED from prose summary, not just a decision line", () => {
	expect(reviewerDecision("## RESULT\nsummary: Overall the export change is APPROVED — two minor doc notes, nothing blocking.\nfindings:\n- none\n## END")).toBe("APPROVED");
});
it("treats NEEDS CHANGES anywhere as not approved even with APPROVED prose", () => {
	expect(reviewerDecision("## RESULT\nstatus: PASS\nsummary: Mostly fine but NEEDS CHANGES on empty-day filtering.\n## END")).toBe("NEEDS CHANGES");
});
it("keeps fail-closed for a positive-sounding narrative with no approval word", () => {
	expect(reviewerDecision("## RESULT\nstatus: PASS\nsummary: The change looks correct; all tests pass.\n## END")).toBe("UNKNOWN");
});
it("does not treat 'not approved' phrasing as approval", () => {
	expect(reviewerDecision("## RESULT\ndecision: NOT APPROVED — see findings\n## END")).toBe("NEEDS CHANGES");
});
