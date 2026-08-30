import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bindAcceptanceContract } from "../lib/execution-contract.ts";
import { completionDecision, pipelineCompleteDecision, verificationRequired } from "../lib/execution-gate.ts";
import { createVerifierReceipt, type VerifierReceipt, workspaceHash } from "../lib/verifier-runtime.ts";

const PLAN = `# Plan: add login

## Verification
1. npm test -- auth.test.ts passes
`;

function contract() {
	const bound = bindAcceptanceContract(PLAN, "plan");
	if ("error" in bound) throw new Error("expected contract");
	return bound;
}

function passReceipt(commandsRun = ["bash: npm test -- auth.test.ts"]): VerifierReceipt {
	const bound = contract();
	const receipt = createVerifierReceipt({
		output: "criterion: npm test -- auth.test.ts passes\nstatus: pass\nPASS",
		contract: bound,
		commandsRun,
		changedFiles: [],
		attempt: 1,
		workspaceHash: workspaceHash("", []),
	});
	if (!receipt) throw new Error("expected receipt");
	return receipt;
}

describe("completion surfaces", () => {
	it("does not gate user /report or non-PLAN show_report", () => {
		expect(verificationRequired("user-report", "PLAN")).toBe(false);
		expect(completionDecision({ surface: "user-report", mode: "PLAN" }).allowed).toBe(true);
		expect(verificationRequired("plan-show-report", "TEAM")).toBe(false);
		expect(completionDecision({ surface: "plan-show-report", mode: "NORMAL" }).allowed).toBe(true);
	});

	it("blocks PLAN show_report without a PASS receipt", () => {
		expect(completionDecision({ surface: "plan-show-report", mode: "PLAN" }).allowed).toBe(false);
		expect(completionDecision({ surface: "plan-show-report", mode: "PLAN", contract: contract() }).allowed).toBe(false);
		expect(completionDecision({
			surface: "plan-show-report",
			mode: "PLAN",
			contract: contract(),
			receipt: passReceipt(),
			workspaceHash: workspaceHash("", []),
		}).allowed).toBe(true);
	});

	it("rejects pipeline complete without PASS regardless of last phase name", () => {
		const planText = `# Plan: build feature\n\n## Verification\n1. npm test\n`;
		expect(pipelineCompleteDecision(planText, undefined).allowed).toBe(false);
		const bound = bindAcceptanceContract(planText, "pipeline");
		if ("error" in bound) throw new Error("expected contract");
		const receipt = createVerifierReceipt({
			output: "criterion: npm test\nstatus: pass\nPASS",
			contract: bound,
			commandsRun: ["bash: npm test"],
			changedFiles: [],
			attempt: 1,
			workspaceHash: workspaceHash("", []),
		});
		expect(pipelineCompleteDecision(planText, receipt, workspaceHash("", [])).allowed).toBe(true);
	});

	it("fails complete when the plan has no checklist", () => {
		const decision = pipelineCompleteDecision("# Plan: x\n\nJust vibes.\n", undefined);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toMatch(/合同不全/);
	});

	it("does not drop a bound planner checklist for an advance_phase summary without a section", () => {
		const planner = `# Plan: build feature\n\n## Verification\n1. npm test\n`;
		const summary = "All phases done. Worker said tests passed.";
		const previous = bindAcceptanceContract(planner, "pipeline");
		if ("error" in previous) throw new Error("expected contract");
		const withoutReceipt = pipelineCompleteDecision(summary, undefined, undefined, previous);
		expect(withoutReceipt.allowed).toBe(false);
		expect(withoutReceipt.reason).not.toMatch(/合同不全/);
		expect(withoutReceipt.contract?.fingerprint).toBe(previous.fingerprint);
		const receipt = createVerifierReceipt({
			output: "criterion: npm test\nstatus: pass\nPASS",
			contract: previous,
			commandsRun: ["bash: npm test"],
			changedFiles: [],
			attempt: 1,
			workspaceHash: workspaceHash("", []),
		});
		expect(pipelineCompleteDecision(summary, receipt, workspaceHash("", []), previous).allowed).toBe(true);
	});

	it("invalidates an old receipt after the plan text changes", () => {
		const original = contract();
		const receipt = passReceipt();
		const edited = PLAN.replace("auth.test.ts", "session.test.ts");
		const next = bindAcceptanceContract(edited, "plan");
		if ("error" in next) throw new Error("expected contract");
		expect(completionDecision({
			surface: "plan-show-report",
			mode: "PLAN",
			contract: original,
			receipt,
			workspaceHash: workspaceHash("", []),
		}).allowed).toBe(true);
		expect(completionDecision({
			surface: "plan-show-report",
			mode: "PLAN",
			contract: next,
			receipt,
		}).allowed).toBe(false);
	});

	it("fails PASS when the contract requires tests but none were run", () => {
		const bound = contract();
		const receipt = createVerifierReceipt({
			output: "criterion: npm test -- auth.test.ts passes\nstatus: pass\nPASS",
			contract: bound,
			commandsRun: ["bash: git diff"],
			changedFiles: [],
			attempt: 1,
			workspaceHash: workspaceHash("", []),
		});
		expect(receipt?.status).toBe("FAIL");
		expect(completionDecision({
			surface: "pipeline-complete",
			contract: bound,
			receipt,
		}).allowed).toBe(false);
	});
});

describe("shipped wiring", () => {
	const root = dirname(fileURLToPath(import.meta.url));

	it("gates every pipeline last phase through pipelineCompleteDecision", () => {
		const src = readFileSync(join(root, "..", "pipeline-team.ts"), "utf8");
		expect(src).toContain("pipelineCompleteDecision");
		expect(src).toContain("runIsolatedVerifier");
		expect(src).toContain("retainBoundChecklist");
		expect(src).toContain("getExecutionContract()");
		expect(src).not.toContain("current.def.name.toLowerCase() === \"review\"");
	});

	it("gates agent show_report in PLAN and leaves user /report ungated", () => {
		const src = readFileSync(join(root, "..", "completion-report.ts"), "utf8");
		expect(src).toContain('surface: "plan-show-report"');
		expect(src).toContain("runIsolatedVerifier");
		const reportStart = src.indexOf('pi.registerCommand("report"');
		expect(reportStart).toBeGreaterThan(0);
		expect(src.slice(reportStart)).not.toContain("completionDecision");
		expect(src.slice(reportStart)).not.toContain("runIsolatedVerifier");
	});
});
