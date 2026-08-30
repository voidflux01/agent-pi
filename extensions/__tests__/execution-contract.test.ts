import { describe, expect, it } from "vitest";
import { bindAcceptanceContract, extractAcceptanceCriteria, planFingerprint, retainBoundChecklist, resolveAcceptanceContract } from "../lib/execution-contract.ts";
import { buildVerifierPrompt, canComplete, collectCommandFromEvent, createVerifierReceipt, parseCriterionStatuses, parseVerifierStatus } from "../lib/verifier-runtime.ts";

const PLAN = `# Plan: add login

## Context
Auth exists.

## Verification
1. npm test -- auth.test.ts passes
2. Login form renders

## Contract
- npm test -- auth.test.ts passes
- login form is on the page
`;

describe("acceptance contract extraction", () => {
	it("prefers ## Contract list items over ## Verification", () => {
		const extracted = extractAcceptanceCriteria(PLAN);
		expect(extracted.section).toBe("Contract");
		expect(extracted.criteria).toEqual([
			"npm test -- auth.test.ts passes",
			"login form is on the page",
		]);
	});

	it("falls back to ## Verification when ## Contract is missing", () => {
		const md = `# Plan: x\n\n## Verification\n1. npm test\n2. File exists\n`;
		const extracted = extractAcceptanceCriteria(md);
		expect(extracted.section).toBe("Verification");
		expect(extracted.criteria).toEqual(["npm test", "File exists"]);
	});

	it("reports incomplete when neither section has list items", () => {
		expect(bindAcceptanceContract("# Plan: x\n\n## Context\nNo checklist.\n", "plan")).toEqual({ error: "incomplete" });
	});

	it("keeps a bound planner checklist when the next text has no section", () => {
		const planner = PLAN;
		const summary = "Build finished. Tests looked fine.";
		expect(retainBoundChecklist(planner, summary)).toBe(planner);
		const previous = bindAcceptanceContract(planner, "pipeline");
		if ("error" in previous) throw new Error("expected contract");
		const resolved = resolveAcceptanceContract(summary, "pipeline", previous);
		if ("error" in resolved) throw new Error("expected retained contract");
		expect(resolved.fingerprint).toBe(previous.fingerprint);
		expect(resolved.criteria).toEqual(previous.criteria);
	});

	it("replaces the bound checklist when the candidate has its own section", () => {
		const next = `# Plan: add login\n\n## Contract\n- cargo test\n`;
		expect(retainBoundChecklist(PLAN, next)).toBe(next);
	});

	it("changes fingerprint when the approved text changes", () => {
		const a = bindAcceptanceContract(PLAN, "plan");
		const b = bindAcceptanceContract(PLAN.replace("login form is on the page", "also logout works"), "plan");
		if ("error" in a || "error" in b) throw new Error("expected contracts");
		expect(a.fingerprint).toBe(planFingerprint(PLAN));
		expect(a.fingerprint).not.toBe(b.fingerprint);
	});
});

describe("verifier parse policy", () => {
	it("parses only an unambiguous terminal decision", () => {
		expect(parseVerifierStatus("Checks complete\nPASS")).toBe("PASS");
		expect(parseVerifierStatus("PASS or FAIL depending on context")).toBeUndefined();
	});

	it("rejects a worker ## RESULT verification claim as PASS even with a trailing PASS line", () => {
		const contract = bindAcceptanceContract(PLAN, "plan");
		if ("error" in contract) throw new Error("expected contract");
		const receipt = createVerifierReceipt({
			output: [
				"## RESULT",
				"done: true",
				"summary: implemented login",
				"- verification: npm test -- auth.test.ts passed",
				"## END",
				"PASS",
			].join("\n"),
			contract,
			commandsRun: [],
			changedFiles: [],
			attempt: 1,
		});
		expect(receipt?.status).toBe("FAIL");
		expect(canComplete(receipt!, contract)).toBe(false);
	});

	it("requires per-criterion parse; a bare PASS is not enough", () => {
		const contract = bindAcceptanceContract(PLAN, "plan");
		if ("error" in contract) throw new Error("expected contract");
		const receipt = createVerifierReceipt({
			output: "Looks good\nPASS",
			contract,
			commandsRun: ["bash: npm test -- auth.test.ts"],
			changedFiles: [],
			attempt: 1,
		});
		expect(receipt?.status).toBe("FAIL");
		expect(receipt?.criteria.every(c => c.status === "unknown")).toBe(true);
		expect(canComplete(receipt!, contract)).toBe(false);
	});

	it("maps parsed criterion lines onto the contract list", () => {
		const parsed = parseCriterionStatuses(
			"criterion: npm test -- auth.test.ts passes\nstatus: pass\ncriterion: login form is on the page\nstatus: fail\nFAIL",
			["npm test -- auth.test.ts passes", "login form is on the page"],
		);
		expect(parsed.map(c => c.status)).toEqual(["pass", "fail"]);
	});

	it("collects bash and run_tests commands from child JSONL events", () => {
		expect(collectCommandFromEvent({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } })).toBe("bash: npm test");
		expect(collectCommandFromEvent({ type: "tool_execution_start", toolName: "run_tests", args: {} })).toBe("run_tests");
		expect(collectCommandFromEvent({ type: "message_update" })).toBeUndefined();
	});

	it("does not put worker narrative in the verifier prompt", () => {
		const contract = bindAcceptanceContract(PLAN, "plan");
		if ("error" in contract) throw new Error("expected contract");
		const prompt = buildVerifierPrompt({ contract, diffPath: "/tmp/diff.patch", evidencePaths: ["/tmp/diff.patch"] });
		expect(prompt).toContain("diff-path");
		expect(prompt).toContain("success-criteria");
		expect(prompt).not.toContain("worker-claims");
		expect(prompt).not.toContain("worker_summary");
		expect(prompt).not.toContain("## RESULT");
	});
});
