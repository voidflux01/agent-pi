import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindAcceptanceContract } from "../lib/execution-contract.ts";
import type { VerifierSubagentReport } from "../lib/verifier-subagent.ts";

const runVerifierSubagent = mock();
mock.module("../lib/verifier-subagent.ts", () => ({ runVerifierSubagent }));
// Dynamic import so the mock is installed before the module evaluates.
const { runAcceptanceVerifier } = await import("../lib/isolated-verifier.ts");

function passReport(): VerifierSubagentReport {
	return {
		status: "PASS",
		summary: "clean",
		requirements: [{ requirement: "objective", status: "PASS", evidence: "base.txt:1", files: ["base.txt"] }],
		contract: { status: "PASS", findings: [] },
		review: { status: "PASS", findings: [] },
		behavior: { status: "PASS", findings: [], tests: { discovered: 0, executed: 0, failed: 0, skipped: 0 } },
		quality: { status: "PASS", findings: [] },
		security: { status: "PASS", findings: [] },
		hard_blockers: [],
		warnings: [],
	};
}

let repo = "";
beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "verifier-guard-"));
	const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
	git(["init", "-q"]);
	git(["config", "user.email", "t@t"]);
	git(["config", "user.name", "t"]);
	writeFileSync(join(repo, "base.txt"), "base\n");
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "init"]);
	runVerifierSubagent.mockReset();
});
afterEach(() => { try { rmSync(repo, { recursive: true, force: true }); } catch { } });

const contract = () => {
	const bound = bindAcceptanceContract("# Plan: p\n\n## Objective\nShip the change.\n", "plan");
	if ("error" in bound) throw new Error("expected contract");
	return bound;
};

const residualReport = (residual: string[]): VerifierSubagentReport => ({
	...passReport(),
	status: "PASS",
	coverage: ["src/a.ts"],
	residual_uncertainty: residual,
});

describe("verifier workspace guard", () => {
	it("passes when the verifier left the workspace alone", async () => {
		runVerifierSubagent.mockResolvedValue({ report: passReport(), runId: "verifier-1", outputText: "" });
		const { receipt } = await runAcceptanceVerifier({ cwd: repo, contract: contract(), attempt: 1 });
		expect(receipt?.status).toBe("PASS");
	});

	it("residual uncertainty is fine on a first-round PASS", async () => {
		runVerifierSubagent.mockResolvedValue({ report: residualReport(["could not run the integration suite"]), runId: "verifier-1", outputText: "" });
		const { receipt } = await runAcceptanceVerifier({ cwd: repo, contract: contract(), attempt: 1 });
		expect(receipt?.status).toBe("PASS");
	});

	it("blocks a re-verification PASS that still carries residual uncertainty", async () => {
		runVerifierSubagent.mockResolvedValue({ report: residualReport(["could not run the integration suite"]), runId: "verifier-2", outputText: "" });
		const { receipt } = await runAcceptanceVerifier({ cwd: repo, contract: contract(), attempt: 2, previousReport: residualReport(["could not run the integration suite"]) });
		expect(receipt?.status).toBe("BLOCKED");
		expect(receipt?.verifier?.report?.hard_blockers.join(" ")).toContain("residual uncertainty");
	});

	it("keeps a re-verification PASS once residual uncertainty is cleared", async () => {
		runVerifierSubagent.mockResolvedValue({ report: residualReport([]), runId: "verifier-2", outputText: "" });
		const { receipt } = await runAcceptanceVerifier({ cwd: repo, contract: contract(), attempt: 2, previousReport: residualReport(["could not run the integration suite"]) });
		expect(receipt?.status).toBe("PASS");
	});

	it("blocks and names the changed path when a file is edited mid-audit", async () => {
		runVerifierSubagent.mockImplementation(async () => {
			writeFileSync(join(repo, "base.txt"), "changed by the verifier\n");
			return { report: passReport(), runId: "verifier-2", outputText: "" };
		});
		const { receipt } = await runAcceptanceVerifier({ cwd: repo, contract: contract(), attempt: 1 });
		const notes = (receipt?.results || []).map(result => result.note || "").join(" ");
		expect(receipt?.status).toBe("BLOCKED");
		expect(notes).toContain("modified base.txt");
		expect(notes).toContain(".pi/manifest-ignore");
	});
});
