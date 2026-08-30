import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindAcceptanceContract } from "../lib/execution-contract.ts";
import { verifierAction } from "../lib/verification-policy.ts";
import { runIsolatedVerifier } from "../lib/isolated-verifier.ts";
import { setExecutionContract, getExecutionContract, setVerifierReceipt, getVerifierReceipt, resetExecutionVerification } from "../lib/coordination-state.ts";
import type { DispatchAuthorization } from "../lib/dispatch-gate.ts";

const PLAN = `# Plan: add login\n\n## Verification\n1. npm test -- auth.test.ts passes\n`;

describe("session-scoped contract receipts", () => {
	it("stores the bound contract and receipt in coordination state", () => {
		resetExecutionVerification();
		const bound = bindAcceptanceContract(PLAN, "plan");
		if ("error" in bound) throw new Error("expected contract");
		setExecutionContract(bound);
		expect(getExecutionContract()?.fingerprint).toBe(bound.fingerprint);
		expect(getVerifierReceipt()).toBeUndefined();
		setVerifierReceipt({
			version: 1,
			status: "PASS",
			planFingerprint: bound.fingerprint,
			criteria: [{ criterion: bound.criteria[0], status: "pass", evidenceIds: [] }],
			commandsRun: ["bash: npm test -- auth.test.ts"],
			changedFiles: [],
			blockers: [],
			attempt: 1,
			createdAt: "now",
		});
		expect(getVerifierReceipt()?.status).toBe("PASS");
		setExecutionContract(bound);
		expect(getVerifierReceipt()?.status).toBe("PASS");
		const edited = bindAcceptanceContract(PLAN.replace("auth.test.ts", "session.test.ts"), "plan");
		if ("error" in edited) throw new Error("expected contract");
		setExecutionContract(edited);
		expect(getVerifierReceipt()).toBeUndefined();
	});
});

describe("verifier retry policy", () => {
	it("only retries actionable failures within the budget", () => {
		expect(verifierAction("FAIL", 1)).toBe("retry");
		expect(verifierAction("FAIL", 3)).toBe("escalate");
		expect(verifierAction("FAIL", 1, 3, false)).toBe("escalate");
		expect(verifierAction("BLOCKED", 1)).toBe("escalate");
		expect(verifierAction("PASS", 1)).toBe("complete");
	});
});

describe("isolated verifier runner", () => {
	it("records commands the child actually ran and builds a receipt from parsed criteria", async () => {
		const repo = mkdtempSync(join(tmpdir(), "pi-verifier-"));
		execFileSync("git", ["init", "-q"], { cwd: repo });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
		writeFileSync(join(repo, "README.md"), "x\n");
		execFileSync("git", ["add", "."], { cwd: repo });
		execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
		const bound = bindAcceptanceContract(PLAN, "pipeline");
		if ("error" in bound) throw new Error("expected contract");
		const auth = { origin: "subagent-tool" as const, token: "test" } as DispatchAuthorization;
		const result = await runIsolatedVerifier({
			cwd: repo,
			contract: bound,
			authorization: auth,
			attempt: 1,
			launchDir: join(repo, ".pi", "agent-sessions"),
			execute: async () => ({
				output: "criterion: npm test -- auth.test.ts passes\nstatus: pass\nPASS",
				commandsRun: ["bash: npm test -- auth.test.ts"],
				exitCode: 0,
			}),
		});
		expect(result.receipt?.status).toBe("PASS");
		expect(result.receipt?.commandsRun).toEqual(["bash: npm test -- auth.test.ts"]);
		expect(result.receipt?.planFingerprint).toBe(bound.fingerprint);
	});

	it("blocks when the verifier process writes the workspace", async () => {
		const repo = mkdtempSync(join(tmpdir(), "pi-dirty-"));
		execFileSync("git", ["init", "-q"], { cwd: repo });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
		writeFileSync(join(repo, "README.md"), "x\n");
		execFileSync("git", ["add", "."], { cwd: repo });
		execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
		const bound = bindAcceptanceContract(PLAN, "pipeline");
		if ("error" in bound) throw new Error("expected contract");
		const auth = { origin: "subagent-tool" as const, token: "test" } as DispatchAuthorization;
		const result = await runIsolatedVerifier({
			cwd: repo,
			contract: bound,
			authorization: auth,
			attempt: 1,
			launchDir: join(repo, ".pi", "agent-sessions"),
			execute: async () => {
				writeFileSync(join(repo, "evil.txt"), "nope\n");
				return { output: "PASS", commandsRun: [], exitCode: 0 };
			},
		});
		expect(result.receipt).toBeUndefined();
		expect(result.error).toMatch(/modified the workspace/);
	});
});
