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
