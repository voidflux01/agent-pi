import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { bindAcceptanceContract } from "../lib/execution-contract.ts";
import { buildWorkspaceManifest } from "../lib/workspace-manifest.ts";
import { resetExecutionVerification } from "../lib/coordination-state.ts";
import { builderRepairDispatcher, runAutonomousCompletion } from "../lib/autonomous-completion.ts";
import { DEFAULT_VERIFIER_ATTEMPTS } from "../lib/verification-policy.ts";

const { runVerifier } = vi.hoisted(() => ({ runVerifier: vi.fn() }));
vi.mock("../lib/isolated-verifier.ts", () => ({ runAcceptanceVerifier: runVerifier }));

const cwd = process.cwd();
const contract = bindAcceptanceContract("## Objective\nShip the bounded completion loop.", "task");

function receipt(status: "PASS" | "FAIL", attempt: number) {
	if ("error" in contract) throw new Error("expected contract");
	return {
		version: 3 as const,
		status,
		contractFingerprint: contract.fingerprint,
		workspaceManifestHash: buildWorkspaceManifest(cwd, contract.fingerprint).hash,
		results: status === "PASS" ? [] : [{ kind: "advisory" as const, raw: "repair needed", status: "blocked" as const, note: "fix" }],
		attempt,
		verifierRequired: true,
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
		runVerifier
			.mockResolvedValueOnce({ receipt: receipt("FAIL", 1) })
			.mockResolvedValueOnce({ receipt: receipt("PASS", 2) });
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

	it("blocks after bounded FAIL attempts", async () => {
		if ("error" in contract) throw new Error("expected contract");
		runVerifier.mockImplementation(async ({ attempt }: { attempt: number }) => ({ receipt: receipt("FAIL", attempt) }));
		let repairs = 0;
		const result = await runAutonomousCompletion({
			contract,
			cwd,
			mode: "NORMAL",
			dispatchRepair: async () => { repairs++; return true; },
		});
		expect(result.allowed).toBe(false);
		expect(result.attempts).toBe(DEFAULT_VERIFIER_ATTEMPTS);
		expect(repairs).toBe(DEFAULT_VERIFIER_ATTEMPTS - 1);
	});

	it("dispatches repair through joined canonical builder scope", async () => {
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
});
