import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { digest } from "../lib/workflow-artifacts.ts";
import { checkRequiredEvalBinding, loadEvalSet, parseEvalSet, runCommandExecution, runUserEvalSet } from "../lib/eval-sets.ts";
import { bindAcceptanceContract } from "../lib/execution-contract.ts";
import { canComplete, createVerifierReceipt } from "../lib/verifier-runtime.ts";

function workspace(): string {
	return mkdtempSync(join(tmpdir(), "agent-pi-evalsets-"));
}

const PASS_RECEIPT = (contract: { fingerprint: string }) => createVerifierReceipt({
	contract: { fingerprint: contract.fingerprint } as any,
	workspaceManifestHash: "same",
	verification: { status: "PASS", results: [{ status: "pass", raw: "ok" }] } as any,
	attempt: 1,
	verifier: { runId: "verifier-1", status: "PASS", summary: "ok" },
});

describe("user eval sets", () => {
	test("loads and hashes a YAML eval set bound by content, not path", () => {
		const cwd = workspace();
		const file = join(cwd, "my-evals.yaml");
		writeFileSync(file, "name: user-regression\nversion: 2\ncases:\n  - id: user-tests\n    version: 1\n    kind: functional\n    task: run user test command\n    timeout_ms: 5000\n    max_tokens: 1\n    executor: command\n    command: echo USER_TESTS_PASS\n    expect:\n      - type: contains\n        value: USER_TESTS_PASS\n");
		const set = loadEvalSet(cwd, "my-evals.yaml");
		expect(set.name).toBe("user-regression");
		expect(set.sha256).toBe(digest("name: user-regression\nversion: 2\ncases:\n  - id: user-tests\n    version: 1\n    kind: functional\n    task: run user test command\n    timeout_ms: 5000\n    max_tokens: 1\n    executor: command\n    command: echo USER_TESTS_PASS\n    expect:\n      - type: contains\n        value: USER_TESTS_PASS\n"));
		expect(set.cases[0].executor).toBe("command");
	});

	test("rejects malformed sets; bare command cases default to the command executor", () => {
		expect(() => parseEvalSet({ name: "x", version: 1, cases: [] }, "0".repeat(64))).toThrow();
		expect(() => parseEvalSet({ name: "bad name!", version: 1, cases: [{ id: "a", version: 1, kind: "functional", task: "t", timeout_ms: 10, max_tokens: 1, executor: "command", command: "true", expect: [{ type: "exit", code: 0 }] }] }, "0".repeat(64))).toThrow();
		expect(() => parseEvalSet({ name: "x", version: 1, cases: [{ id: "a", version: 1, kind: "functional", task: "t", timeout_ms: 10, max_tokens: 1, executor: "command", expect: [{ type: "exit", code: 0 }] }] }, "0".repeat(64))).toThrow();
		const defaulted = parseEvalSet({ name: "x", version: 1, cases: [{ id: "a", version: 1, kind: "functional", task: "t", timeout_ms: 10, max_tokens: 1, command: "true", expect: [{ type: "exit", code: 0 }] }] }, "0".repeat(64));
		expect(defaulted.cases[0].executor).toBe("command");
	});

	test("command executor runs user tests and non-zero exits become FAIL evidence", async () => {
		const cwd = workspace();
		const good = await runUserEvalSet(cwd, parseEvalSet({ name: "s", version: 1, cases: [{ id: "pass-case", version: 1, kind: "functional", task: "t", timeout_ms: 5000, max_tokens: 1, executor: "command", command: "echo USER_TESTS_PASS", expect: [{ type: "contains", value: "USER_TESTS_PASS" }] }] }, digest("x")));
		expect(good[0].status).toBe("PASS");
		expect(good[0].completionAllowed).toBe(false);
		expect(good[0].eval_set_sha256).toBe(digest("x"));
		const bad = await runUserEvalSet(cwd, parseEvalSet({ name: "s", version: 1, cases: [{ id: "fail-case", version: 1, kind: "functional", task: "t", timeout_ms: 5000, max_tokens: 1, executor: "command", command: "false", expect: [{ type: "exit", code: 0 }] }] }, digest("x")));
		expect(bad[0].status).toBe("FAIL");
	});

	test("command executor blocks on missing binaries instead of failing the case", async () => {
		const cwd = workspace();
		const execution = await runCommandExecution(cwd, { id: "x", version: 1, kind: "functional", task: "t", timeout_ms: 5000, max_tokens: 1, executor: "command", command: "definitely-not-a-real-binary-xyz --version", expect: [] } as any, new AbortController().signal);
		expect(execution.blocked).toContain("could not start");
	});

	test("unavailable executors report BLOCKED, never PASS", async () => {
		const cwd = workspace();
		const reports = await runUserEvalSet(cwd, parseEvalSet({ name: "s", version: 1, cases: [{ id: "live", version: 1, kind: "workflow", task: "t", timeout_ms: 5000, max_tokens: 1, executor: "pi-workflow", expect: [{ type: "exit", code: 0 }] }] }, digest("x")));
		expect(reports[0].status).toBe("BLOCKED");
	});

	test("[eval] assertion binds a contract to the eval set hash", () => {
		const contract = bindAcceptanceContract("# Objective\nDo it.\n\n## Contract\n- npm test\n- [eval] evals/user-set.yaml sha256:" + "a".repeat(64) + "\n", "plan") as any;
		if ("error" in contract) throw new Error("contract should bind");
		expect(contract.requiredEval).toMatchObject({ path: "evals/user-set.yaml", sha256: "a".repeat(64) });
	});

	test("missing, stale and failed eval reports block completion; fresh PASS passes", () => {
		const cwd = workspace();
		const binding = { path: "evals/user-set.yaml", sha256: "b".repeat(64) };
		const contract = { fingerprint: "fp", requiredEval: binding } as any;
		expect(checkRequiredEvalBinding(cwd, binding).ok).toBe(false);
		// A PASS receipt alone cannot satisfy the gate without the eval report.
		expect(canComplete(PASS_RECEIPT({ fingerprint: "fp" }), contract, "same")).toBe(false);
		// Save a fresh PASS report bound to the set hash.
		mkdirSync(join(cwd, ".pi/workflow/evals"), { recursive: true });
		const report = { schema_version: 1, run_id: "r1", case_id: "c", case_version: 1, kind: "functional", created_at: new Date().toISOString(), status: "PASS", elapsed_ms: 1, model: "command:echo", tokens: 0, eval_set: "user-set", eval_set_sha256: binding.sha256, budget: { timeout_ms: 1, max_tokens: 1 }, evidence: [], checks: [{ status: "PASS", reason: "ok" }], completionAllowed: false };
		const reportPath = join(cwd, ".pi/workflow/evals/run-1.json");
		writeFileSync(reportPath, JSON.stringify(report));
		expect(checkRequiredEvalBinding(cwd, binding).ok).toBe(true);
		expect(canComplete(PASS_RECEIPT({ fingerprint: "fp" }), contract, "same", { ok: true })).toBe(true);
		// Stale report expires the gate.
		utimesSync(reportPath, new Date(Date.now() - 25 * 60 * 60 * 1000), new Date(Date.now() - 25 * 60 * 60 * 1000));
		// createdAt inside the report decides freshness, not file mtime; write an old one.
		writeFileSync(reportPath, JSON.stringify({ ...report, created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }));
		expect(checkRequiredEvalBinding(cwd, binding).ok).toBe(false);
	});
});
