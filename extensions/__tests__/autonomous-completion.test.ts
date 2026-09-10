import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bindAcceptanceContract } from "../lib/execution-contract.ts";
import { buildWorkspaceManifest } from "../lib/workspace-manifest.ts";
import { resetExecutionVerification } from "../lib/coordination-state.ts";
import { builderRepairDispatcher, runAutonomousCompletion } from "../lib/autonomous-completion.ts";
import { grantCompletionOverride } from "../lib/completion-override.ts";
import { DEFAULT_VERIFIER_ATTEMPTS } from "../lib/verification-policy.ts";

const { runVerifier } = vi.hoisted(() => ({ runVerifier: vi.fn() }));
vi.mock("../lib/isolated-verifier.ts", () => ({ runAcceptanceVerifier: runVerifier }));

const contract = bindAcceptanceContract("## Objective\nShip the bounded completion loop.", "task");

function receipt(cwd: string, status: "PASS" | "FAIL", attempt: number) {
	if ("error" in contract) throw new Error("expected contract");
	return {
		version: 3 as const,
		status,
		contractFingerprint: contract.fingerprint,
		workspaceManifestHash: buildWorkspaceManifest(cwd, contract.fingerprint).hash,
		results: status === "PASS" ? [] : [{ raw: "repair needed", status: "blocked" as const, note: "fix" }],
		attempt,
		verifier: { runId: `verifier-${attempt}`, status, summary: status === "PASS" ? "pass" : "fail" },
		createdAt: new Date().toISOString(),
	};
}

beforeEach(() => {
	resetExecutionVerification();
	runVerifier.mockReset();
});

afterEach(() => {
	(globalThis as any).__piRegisteredToolExecutors = Object.create(null);
});

describe("autonomous completion loop", () => {
	it("repairs after FAIL and admits only the following PASS", async () => {
		if ("error" in contract) throw new Error("expected contract");
		const cwd = mkdtempSync(join(tmpdir(), "autonomous-completion-"));
		runVerifier
			.mockResolvedValueOnce({ receipt: receipt(cwd, "FAIL", 1) })
			.mockResolvedValueOnce({ receipt: receipt(cwd, "PASS", 2) });
		let repairs = 0;
		const result = await runAutonomousCompletion({
			contract,
			cwd,
			mode: "NORMAL",
			dispatchRepair: async () => { repairs++; return true; },
		});
		expect(result.allowed).toBe(true);
		expect(result.attempts).toBe(2);
		expect(repairs).toBe(1);
		expect(runVerifier).toHaveBeenCalledTimes(2);
	});

	it("replans after repeated FAIL attempts", async () => {
		if ("error" in contract) throw new Error("expected contract");
		const cwd = mkdtempSync(join(tmpdir(), "autonomous-completion-"));
		runVerifier.mockImplementation(async ({ attempt }: { attempt: number }) => ({ receipt: receipt(cwd, "FAIL", attempt) }));
		let repairs = 0;
		const result = await runAutonomousCompletion({
			contract,
			cwd,
			mode: "NORMAL",
			dispatchRepair: async () => { repairs++; return true; },
		});
		expect(result.allowed).toBe(false);
		expect(result.attempts).toBe(2);
		expect(result.iteration?.action).toBe("REPLAN");
		expect(repairs).toBe(1);
	});

	it("returns REPLAN for requirements failure without repair", async () => {
		if ("error" in contract) throw new Error("expected contract");
		const cwd = mkdtempSync(join(tmpdir(), "autonomous-completion-"));
		runVerifier.mockResolvedValueOnce({ receipt: receipt(cwd, "FAIL", 1) });
		let repairs = 0;
		const result = await runAutonomousCompletion({ contract, cwd, mode: "NORMAL", failure: "requirements", dispatchRepair: async () => { repairs++; return true; } });
		expect(result.allowed).toBe(false);
		expect(result.iteration).toMatchObject({ action: "REPLAN", nextMode: "SPEC", requiresApproval: true });
		expect(repairs).toBe(0);
	});

	it("dispatches repair through joined canonical builder scope", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "autonomous-completion-"));
		const executor = vi.fn().mockResolvedValue({ details: { status: "done" } });
		(globalThis as any).__piRegisteredToolExecutors = { subagent_create: executor };
		const dispatched = await builderRepairDispatcher({ cwd } as any)("fix verifier failure");
		expect(dispatched).toBe(true);
		expect(executor).toHaveBeenCalledWith(
			"autonomous-repair",
			{ name: "builder", task: "fix verifier failure", join: true, scope: "autonomous-repair" },
			undefined,
			undefined,
			{ cwd },
		);
		executor.mockResolvedValueOnce({ details: { status: "error", error: true } });
		expect(await builderRepairDispatcher({ cwd } as any)("broken repair")).toBe(false);
	});

	it("admits completion on a recorded user override without running the verifier", async () => {
		if ("error" in contract) throw new Error("expected contract");
		const cwd = mkdtempSync(join(tmpdir(), "autonomous-completion-"));
		const granted = grantCompletionOverride(cwd, contract, "user approved despite verifier BLOCK");
		expect(granted.approved).toBe(true);
		const result = await runAutonomousCompletion({ contract, cwd, mode: "NORMAL" });
		expect(result.allowed).toBe(true);
		expect(result.reason).toContain("override");
		expect(runVerifier).not.toHaveBeenCalled();
	});
});
