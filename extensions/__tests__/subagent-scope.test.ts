// ABOUTME: Tests for the pure same-scope dispatch decision used by subagent tools.

import { describe, expect, it } from "vitest";

import { decideScopeDispatch, type ScopeWorkerSnapshot } from "../lib/subagent-scope.ts";

const worker = (overrides: Partial<ScopeWorkerSnapshot>): ScopeWorkerSnapshot => ({
	id: 7,
	name: "verifier",
	scope: "auth-review",
	status: "done",
	...overrides,
});

describe("decideScopeDispatch", () => {
	it("spawns when scope is empty or missing", () => {
		expect(decideScopeDispatch([], "verifier", "").action).toBe("spawn");
		const running = [worker({ status: "running" })];
		expect(decideScopeDispatch(running, "verifier", "  ").action).toBe("spawn");
	});

	it("spawns when no worker matches the scope", () => {
		const others = [
			worker({ id: 1, scope: "other-scope", status: "running" }),
			worker({ id: 2, name: "reviewer", status: "running" }),
			worker({ id: 3, scope: undefined }),
		];
		const decision = decideScopeDispatch(others, "verifier", "auth-review");
		expect(decision.action).toBe("spawn");
		expect(decision.priorNote).toBe("");
	});

	it("blocks when a same-scope worker is running", () => {
		const decision = decideScopeDispatch([worker({ status: "running" })], "VERIFIER", "auth-review");
		expect(decision.action).toBe("blocked-running");
		if (decision.action === "blocked-running") {
			expect(decision.existingId).toBe(7);
			expect(decision.message).toContain("already running");
			expect(decision.message).toContain("force: true");
		}
	});

	it("blocks when a same-scope worker already PASSED", () => {
		const decision = decideScopeDispatch([worker({ resultStatus: "PASS" })], "verifier", "auth-review");
		expect(decision.action).toBe("blocked-pass");
		if (decision.action === "blocked-pass") {
			expect(decision.message).toContain("PASS");
			expect(decision.message).toContain("force: true");
		}
	});

	it("allows a new round after FAIL and returns a prior pointer", () => {
		const decision = decideScopeDispatch([worker({ resultStatus: "FAIL" })], "verifier", "auth-review");
		expect(decision.action).toBe("spawn");
		if (decision.action === "spawn") {
			expect(decision.priorNote).toContain("SA7");
			expect(decision.priorNote).toContain("FAIL");
			expect(decision.priorNote).toContain("narrow");
		}
	});

	it("allows a new round when the prior run had no valid RESULT", () => {
		const decision = decideScopeDispatch([worker({ status: "error" })], "verifier", "auth-review");
		expect(decision.action).toBe("spawn");
		if (decision.action === "spawn") expect(decision.priorNote).toContain("without a valid RESULT");
	});

	it("uses the latest matching worker when several exist", () => {
		const decision = decideScopeDispatch([
			worker({ id: 1, resultStatus: "PASS" }),
			worker({ id: 2, resultStatus: "FAIL" }),
		], "verifier", "auth-review");
		expect(decision.action).toBe("spawn");
		if (decision.action === "spawn") expect(decision.priorNote).toContain("SA2");
	});

	it("matching is case-insensitive on name but exact on scope", () => {
		expect(decideScopeDispatch([worker({ status: "running" })], "Verifier", "auth-review").action).toBe("blocked-running");
		expect(decideScopeDispatch([worker({ status: "running" })], "verifier", "Auth-Review").action).toBe("spawn");
	});
});
