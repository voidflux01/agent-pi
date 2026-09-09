import { describe, expect, it } from "bun:test";
import { bindTaskContract } from "../lib/autonomous-policy.ts";

describe("bindTaskContract admission", () => {
	it("uses the full natural-language task text as the verifiable Objective", () => {
		const bound = bindTaskContract("Fix the auth token expiry bug, then add a regression test.", "/tmp");
		expect(bound.contract).toBeDefined();
		expect(bound.contract!.objective).toBe("Fix the auth token expiry bug, then add a regression test.");
	});

	it("prefers a structured Objective section when present", () => {
		const task = "## Objective\nShip the export button.\n## Scope\nCLI only.";
		const bound = bindTaskContract(task, "/tmp");
		expect(bound.contract!.objective).toBe("Ship the export button.");
	});

	it("still admits a structured Contract section", () => {
		const task = "## Contract\n### Objective\nAdd --since flag to jd export.";
		const bound = bindTaskContract(task, "/tmp");
		expect(bound.contract!.objective).toBe("Add --since flag to jd export.");
	});

	it("rejects empty tasks", () => {
		expect(bindTaskContract("   ", "/tmp").contract).toBeUndefined();
	});
});