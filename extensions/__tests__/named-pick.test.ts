// ABOUTME: Tests for slash-command name matching (chain/pipeline/team).
import { describe, expect, it } from "vitest";
import { matchNamedOption } from "../lib/named-pick.ts";

describe("matchNamedOption", () => {
	const names = ["plan-build", "plan-build-review", "full-pipeline"];

	it("matches exact names case-insensitively", () => {
		expect(matchNamedOption(names, "plan-build")).toBe("plan-build");
		expect(matchNamedOption(names, "PLAN-BUILD-REVIEW")).toBe("plan-build-review");
	});

	it("matches a unique prefix", () => {
		expect(matchNamedOption(names, "full")).toBe("full-pipeline");
	});

	it("returns undefined for empty, unknown, or ambiguous prefixes", () => {
		expect(matchNamedOption(names, "")).toBeUndefined();
		expect(matchNamedOption(names, "nope")).toBeUndefined();
		expect(matchNamedOption(names, "plan-build")).toBe("plan-build");
		expect(matchNamedOption(names, "plan")).toBeUndefined();
	});
});
