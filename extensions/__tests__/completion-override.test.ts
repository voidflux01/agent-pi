import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bindAcceptanceContract } from "../lib/execution-contract.ts";
import { grantCompletionOverride, hasCompletionOverride, overrideProposal, OVERRIDE_ACTION } from "../lib/completion-override.ts";

function bind(text: string) {
	const bound = bindAcceptanceContract(text, "task");
	if ("error" in bound) throw new Error("expected contract");
	return bound;
}

describe("completion override", () => {
	it("records a grant and reports it active for the same contract", () => {
		const cwd = mkdtempSync(join(tmpdir(), "completion-override-"));
		const contract = bind("## Objective\nFinish login override.");
		expect(hasCompletionOverride(cwd, contract)).toBe(false);
		const granted = grantCompletionOverride(cwd, contract, "user approved despite verifier BLOCK");
		expect(granted.approved).toBe(true);
		expect(hasCompletionOverride(cwd, contract)).toBe(true);
	});

	it("is bound to the contract fingerprint and does not leak across contracts", () => {
		const cwd = mkdtempSync(join(tmpdir(), "completion-override-"));
		const a = bind("## Objective\nContract A override.");
		const b = bind("## Objective\nContract B different.");
		grantCompletionOverride(cwd, a, "approved");
		expect(hasCompletionOverride(cwd, a)).toBe(true);
		expect(hasCompletionOverride(cwd, b)).toBe(false);
	});

	it("uses a stable canonical action and proposal", () => {
		const contract = bind("## Objective\nStable override.");
		const p = overrideProposal(contract);
		expect(p.action).toBe(OVERRIDE_ACTION);
		expect(p.scope).toBe(contract.fingerprint);
		const again = overrideProposal(contract);
		expect(again).toEqual(p);
	});
});
