import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bindAcceptanceContract, bindSpecContract } from "../lib/execution-contract.ts";
import { verifierDispatchCommand } from "../lib/isolated-verifier.ts";
import { completionDecision, pipelineCompleteDecision, verificationRequired } from "../lib/execution-gate.ts";
import { createVerifierReceipt, type VerifierReceipt, workspaceHash } from "../lib/verifier-runtime.ts";

const PLAN = `# Plan: add login

## Verification
1. npm test -- auth.test.ts passes
`;

const SPEC = `# Spec: add login

## Requirements
1. npm test -- auth.test.ts passes
2. Login page renders
`;

function contract() {
	const bound = bindAcceptanceContract(PLAN, "plan");
	if ("error" in bound) throw new Error("expected contract");
	return bound;
}

function specContract() {
	const bound = bindSpecContract(SPEC);
	if ("error" in bound) throw new Error("expected contract");
	return bound;
}

function specPassReceipt(): VerifierReceipt {
	const bound = specContract();
	const receipt = createVerifierReceipt({
		output: "criterion: npm test -- auth.test.ts passes\nstatus: pass\ncriterion: Login page renders\nstatus: pass\nPASS",
		contract: bound,
		commandsRun: ["bash: npm test -- auth.test.ts"],
		changedFiles: [],
		attempt: 1,
		workspaceHash: workspaceHash("", []),
	});
	if (!receipt) throw new Error("expected receipt");
	return receipt;
}

function passReceipt(commandsRun = ["bash: npm test -- auth.test.ts"], bound = contract()): VerifierReceipt {
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
	it("does not gate user /report or show_report without a bound contract", () => {
		expect(verificationRequired({ surface: "user-report", contract: contract() })).toBe(false);
		expect(completionDecision({ surface: "user-report", contract: contract() }).allowed).toBe(true);
		expect(verificationRequired({ surface: "plan-show-report" })).toBe(false);
		expect(completionDecision({ surface: "plan-show-report" }).allowed).toBe(true);
	});

	it("gates any show_report once a contract is bound, regardless of mode", () => {
		// PLAN contract bound, any mode.
		expect(verificationRequired({ surface: "plan-show-report", contract: contract() })).toBe(true);
		expect(completionDecision({ surface: "plan-show-report", contract: contract() }).allowed).toBe(false);
		expect(completionDecision({
			surface: "plan-show-report",
			contract: contract(),
			receipt: passReceipt(),
			workspaceHash: workspaceHash("", []),
		}).allowed).toBe(true);
		// SPEC contract bound, any mode.
		expect(verificationRequired({ surface: "spec-show-report", contract: specContract() })).toBe(true);
		expect(completionDecision({ surface: "spec-show-report", contract: specContract() }).allowed).toBe(false);
		expect(completionDecision({
			surface: "spec-show-report",
			contract: specContract(),
			receipt: specPassReceipt(),
			workspaceHash: workspaceHash("", []),
		}).allowed).toBe(true);
	});

	it("binds spec contract from Requirements list", () => {
		const bound = specContract();
		expect(bound.source).toBe("spec");
		expect(bound.criteria).toHaveLength(2);
		expect(bound.requiresTests).toBe(true);
		expect(bindSpecContract("# Spec\n\nNo checklist.")).toEqual({ error: "incomplete" });
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
			contract: original,
			receipt,
			workspaceHash: workspaceHash("", []),
		}).allowed).toBe(true);
		expect(completionDecision({
			surface: "plan-show-report",
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

	it("uses the isolated verifier and withholds write/dispatch tools", () => {
		const src = readFileSync(join(root, "..", "lib", "isolated-verifier.ts"), "utf8");
		expect(verifierDispatchCommand("check")).not.toContain("--no-extensions");
		expect(verifierDispatchCommand("check").join(" ")).toContain("--tools read,grep,find,ls,bash,run_tests");
		expect(src).not.toContain('"write"');
		expect(src).not.toContain('"verify_execution"');
	});

	it("starts team, chain, pipeline, and subagent children with host extensions", () => {
		for (const file of ["agent-team.ts", "agent-chain.ts", "pipeline-team.ts", "subagent-widget.ts"]) {
			expect(readFileSync(join(root, "..", file), "utf8")).not.toContain("--no-extensions");
		}
	});

	it("gates agent show_report by bound contract and leaves user /report ungated", () => {
		const src = readFileSync(join(root, "..", "completion-report.ts"), "utf8");
		expect(src).toContain('surface = contract?.source === "spec" ? "spec-show-report" : "plan-show-report"');
		expect(src).toContain("runIsolatedVerifier");
		const reportStart = src.indexOf('pi.registerCommand("report"');
		expect(reportStart).toBeGreaterThan(0);
		expect(src.slice(reportStart)).not.toContain("completionDecision");
		expect(src.slice(reportStart)).not.toContain("runIsolatedVerifier");
	});
});
