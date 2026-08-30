import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindAcceptanceContract } from "../lib/execution-contract.ts";
import { verifierAction } from "../lib/verification-policy.ts";
import { runIsolatedVerifier } from "../lib/isolated-verifier.ts";
import { buildWorkspaceManifest } from "../lib/workspace-manifest.ts";
import { setExecutionContract, getExecutionContract, setVerifierReceipt, getVerifierReceipt, resetExecutionVerification } from "../lib/coordination-state.ts";

const PLAN = `# Plan: add login\n\n## Contract\n- [cmd] ${process.execPath} -e "process.exit(0)"\n`;

describe("session-scoped contract receipts", () => {
	it("stores the bound contract and receipt in coordination state", () => {
		resetExecutionVerification();
		const bound = bindAcceptanceContract(PLAN, "plan");
		if ("error" in bound) throw new Error("expected contract");
		setExecutionContract(bound);
		expect(getExecutionContract()?.fingerprint).toBe(bound.fingerprint);
		expect(getVerifierReceipt()).toBeUndefined();
		setVerifierReceipt({
			version: 2,
			status: "PASS",
			contractFingerprint: bound.fingerprint,
			workspaceManifestHash: "m",
			results: [{ kind: "cmd", raw: "[cmd] node -e exit(0)", status: "pass" }],
			attempt: 1,
			createdAt: "now",
		});
		expect(getVerifierReceipt()?.status).toBe("PASS");
		setExecutionContract(bound);
		expect(getVerifierReceipt()?.status).toBe("PASS");
		const edited = bindAcceptanceContract(PLAN.replace("exit(0)", "exit(1)"), "plan");
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

describe("deterministic verifier runner", () => {
	function makeRepo(): string {
		const repo = mkdtempSync(join(tmpdir(), "pi-verifier-"));
		execFileSync("git", ["init", "-q"], { cwd: repo });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
		writeFileSync(join(repo, "README.md"), "x\n");
		execFileSync("git", ["add", "."], { cwd: repo });
		execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
		return repo;
	}

	function repoPlan(code: string): ReturnType<typeof bindAcceptanceContract> {
		return bindAcceptanceContract(`# Plan: p\n\n## Contract\n- [cmd] ${process.execPath} -e "process.exit(${code})"\n`, "pipeline");
	}

	it("builds a PASS receipt from deterministic assertions with manifest binding", async () => {
		const repo = makeRepo();
		try {
			const bound = repoPlan("0");
			if ("error" in bound) throw new Error("expected contract");
			const result = await runIsolatedVerifier({ cwd: repo, contract: bound, attempt: 1 });
			expect(result.receipt?.status).toBe("PASS");
			expect(result.receipt?.contractFingerprint).toBe(bound.fingerprint);
			expect(result.receipt?.workspaceManifestHash).toMatch(/^[0-9a-f]{64}$/);
			expect(result.receipt?.results.every(r => r.status === "pass")).toBe(true);
		} finally { rmSync(repo, { recursive: true, force: true }); }
	});

	it("builds a FAIL receipt when an assertion command fails", async () => {
		const repo = makeRepo();
		try {
			const bound = repoPlan("1");
			if ("error" in bound) throw new Error("expected contract");
			const result = await runIsolatedVerifier({ cwd: repo, contract: bound, attempt: 1 });
			expect(result.receipt?.status).toBe("FAIL");
		} finally { rmSync(repo, { recursive: true, force: true }); }
	});

	it("verification never modifies the workspace", async () => {
		const repo = makeRepo();
		try {
			const bound = repoPlan("0");
			if ("error" in bound) throw new Error("expected contract");
			const before = buildWorkspaceManifest(repo, bound.fingerprint);
			await runIsolatedVerifier({ cwd: repo, contract: bound, attempt: 1 });
			const after = buildWorkspaceManifest(repo, bound.fingerprint);
			expect(after.hash).toBe(before.hash);
		} finally { rmSync(repo, { recursive: true, force: true }); }
	});
});