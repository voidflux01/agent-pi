import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bindAcceptanceContract, bindSpecContract, emptyContract, type AcceptanceContract } from "../lib/execution-contract.ts";
import { completeDecision, pipelineCompleteDecision, verificationRequired } from "../lib/execution-gate.ts";
import { createVerifierReceipt, type VerifierReceipt } from "../lib/verifier-runtime.ts";
import type { DeterministicVerification } from "../lib/deterministic-verifier.ts";

const PLAN = `# Plan: add login

## Contract
- [cmd] npm test -- auth.test.ts
- [file] extensions/lib/execution-contract.ts
`;

const SPEC = `# Spec: add login

## Requirements
- [cmd] npm test -- auth.test.ts
- login page renders (advisory)
`;

function contract(): AcceptanceContract {
	const bound = bindAcceptanceContract(PLAN, "plan");
	if ("error" in bound) throw new Error("expected contract");
	return bound;
}

function specContract(): AcceptanceContract {
	const bound = bindSpecContract(SPEC);
	if ("error" in bound) throw new Error("expected contract");
	return bound;
}

function verification(status: DeterministicVerification["status"] = "PASS"): DeterministicVerification {
	return {
		status,
		results: status === "PASS"
			? [{ kind: "cmd" as const, raw: "[cmd] npm test -- auth.test.ts", status: "pass" as const }]
			: [{ kind: "cmd" as const, raw: "[cmd] npm test -- auth.test.ts", status: status === "fail" ? "fail" as const : "blocked" as const, note: "boom" }],
	};
}

function receipt(bound: AcceptanceContract, manifestHash = "m1", status: DeterministicVerification["status"] = "PASS"): VerifierReceipt {
	return createVerifierReceipt({
		contract: bound,
		workspaceManifestHash: manifestHash,
		verification: verification(status),
		attempt: 1,
	});
}

describe("completion gate (contract-bound)", () => {
	it("does not gate user /report or show_report without a bound contract", () => {
		expect(verificationRequired({ surface: "user-report", contract: contract() })).toBe(false);
		expect(completeDecision({ surface: "user-report", contract: contract() }).allowed).toBe(true);
		expect(verificationRequired({ surface: "plan-show-report" })).toBe(false);
		expect(completeDecision({ surface: "plan-show-report" }).allowed).toBe(true);
	});

	it("gates every show_report once a verifiable contract is bound, in any mode", () => {
		for (const surface of ["plan-show-report", "spec-show-report"] as const) {
			expect(verificationRequired({ surface, contract: contract() })).toBe(true);
			expect(completeDecision({ surface, contract: contract() }).allowed).toBe(false);
			const bound = surface === "spec-show-report" ? specContract() : contract();
			expect(completeDecision({ surface, contract: bound, receipt: receipt(bound), workspaceManifestHash: "m1" }).allowed).toBe(true);
		}
	});

	it("rejects completion when the deterministic run FAILs despite any LLM claim", () => {
		const bound = contract();
		const failed = receipt(bound, "m1", "FAIL");
		expect(failed.status).toBe("FAIL");
		expect(completeDecision({ surface: "plan-show-report", contract: bound, receipt: failed, workspaceManifestHash: "m1" }).allowed).toBe(false);
	});

	it("rejects pipeline complete without a matching receipt", () => {
		expect(pipelineCompleteDecision(PLAN, undefined, "m1").allowed).toBe(false);
		expect(pipelineCompleteDecision(PLAN, receipt(contract(), "m1"), "m1").allowed).toBe(true);
	});

	it("invalidates a receipt when the contract fingerprint changes", () => {
		const original = contract();
		const edited = bindAcceptanceContract(PLAN.replace("auth.test.ts", "session.test.ts"), "plan");
		if ("error" in edited) throw new Error("expected contract");
		expect(completeDecision({ surface: "plan-show-report", contract: original, receipt: receipt(original), workspaceManifestHash: "m1" }).allowed).toBe(true);
		expect(completeDecision({ surface: "plan-show-report", contract: edited, receipt: receipt(original), workspaceManifestHash: "m1" }).allowed).toBe(false);
	});

	it("invalidates a receipt when the workspace manifest changes", () => {
		const bound = contract();
		expect(completeDecision({ surface: "plan-show-report", contract: bound, receipt: receipt(bound, "m1"), workspaceManifestHash: "m1" }).allowed).toBe(true);
		expect(completeDecision({ surface: "plan-show-report", contract: bound, receipt: receipt(bound, "m1"), workspaceManifestHash: "m2" }).allowed).toBe(false);
	});

	it("refuses completion when the bound contract has no executable assertions", () => {
		const unverifiable = emptyContract("# Plan: x\n\n## Contract\n- login page renders\n", "plan");
		// A bound but unverifiable contract must block completion, never skip it.
		expect(verificationRequired({ surface: "plan-show-report", contract: unverifiable })).toBe(true);
		const decision = completeDecision({ surface: "plan-show-report", contract: unverifiable });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toMatch(/合同不可验证/);
		expect(decision.reason).toContain("[cmd]");
		const pipeline = pipelineCompleteDecision("# Plan: x\n\n## Verification\n1. npm test passes\n", undefined, "m1");
		expect(pipeline.allowed).toBe(false);
		expect(pipeline.reason).toMatch(/合同不可验证/);
	});
});

describe("shipped wiring", () => {
	const root = dirname(fileURLToPath(import.meta.url));

	it("gates every pipeline last phase through pipelineCompleteDecision", () => {
		const src = readFileSync(join(root, "..", "pipeline-team.ts"), "utf8");
		expect(src).toContain("pipelineCompleteDecision");
		expect(src).toContain("runAcceptanceVerifier");
		expect(src).toContain("buildWorkspaceManifest");
		expect(src).not.toContain("current.def.name.toLowerCase() === \"review\"");
	});

	it("does not use LLM PASS parsing or git-diff hashing anywhere in the gate", () => {
		const gateSrc = readFileSync(join(root, "..", "lib", "execution-gate.ts"), "utf8");
		const verifierSrc = readFileSync(join(root, "..", "lib", "verifier-runtime.ts"), "utf8");
		const verifierEntry = readFileSync(join(root, "..", "lib", "isolated-verifier.ts"), "utf8");
		expect(gateSrc).toContain("completeDecision");
		expect(verifierSrc).not.toContain("parseVerifierStatus");
		expect(verifierSrc).not.toContain("workspaceHash");
		expect(verifierEntry).not.toContain("authorization:");
		expect(verifierEntry).not.toContain("runDispatch");
	});

	it("starts team, chain, pipeline, and subagent children with host extensions", () => {
		for (const file of ["agent-team.ts", "agent-chain.ts", "pipeline-team.ts", "subagent-widget.ts"]) {
			expect(readFileSync(join(root, "..", file), "utf8")).not.toContain("--no-extensions");
		}
	});

	it("gates agent show_report and leaves user /report ungated", () => {
		const src = readFileSync(join(root, "..", "completion-report.ts"), "utf8");
		expect(src).toContain('surface = contract?.source === "spec" ? "spec-show-report" : "plan-show-report"');
		expect(src).toContain("runAcceptanceVerifier");
		expect(src).toContain("buildWorkspaceManifest");
		const reportStart = src.indexOf('pi.registerCommand("report"');
		expect(reportStart).toBeGreaterThan(0);
		expect(src.slice(reportStart)).not.toContain("completeDecision");
		expect(src.slice(reportStart)).not.toContain("runIsolatedVerifier");
	});

	it("records deterministic verification status in the orchestration event trail", () => {
		const src = readFileSync(join(root, "..", "execution-verifier.ts"), "utf8");
		expect(src).toContain('actor: "verify_execution"');
		expect(src).toContain('verification.started');
		expect(src).toContain('verification.completed');
		expect(src).toContain("verificationStatus");
	});

	it("passes the bound contract file path to the verifier prompt", () => {
		const src = readFileSync(join(root, "..", "lib", "verifier-subagent.ts"), "utf8");
		expect(src).toContain("Approved contract file path");
		expect(src).toContain("contract.contractPath");
		expect(src).toContain('verifierPrompt(input.contract, input.deterministicEvidence, input.contractText),');
		expect(src).toContain("const initialPrompt = [");
		expect(src).not.toContain('"--append-system-prompt", VERIFIER_SYSTEM_PROMPT');
	});
});
