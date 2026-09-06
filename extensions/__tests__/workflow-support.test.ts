import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { aggregateEvalStatus, evaluateCase, parseEvalCase, parseJudgeVerdict } from "../lib/eval-engine.ts";
import { inspectProjectContext, contextDrift } from "../lib/workflow-context.ts";
import { workflowDirection } from "../lib/workflow-direction.ts";
import { deploymentGate, inspectLog } from "../lib/workflow-monitor.ts";
import { redactEvidence, saveArtifact } from "../lib/workflow-artifacts.ts";
import workflowSupport from "../workflow-support.ts";
import { saveRetrospective, searchRetrospectives, augmentRetrospective, markInsight, listRetrospectives, clearRetrospectives } from "../lib/workflow-memory.ts";

describe("workflow support boundaries", () => {
	test("loads as a Pi extension and registers the complete workflow surface", () => {
		const tools: string[] = [];
		const commands: string[] = [];
		workflowSupport({
			registerTool(definition: { name: string }) { tools.push(definition.name); },
			registerCommand(name: string) { commands.push(name); },
			on() {},
		} as any);

		expect(tools).toEqual([
			"workflow_advice",
			"context_draft",
			"log_watch",
			"deployment_checklist",
			"workflow_approval",
			"eval_run",
		]);
		expect(commands).toEqual(["workflow"]);
	});

	test("rejects malformed eval cases and judge citations", () => {
		expect(() => parseEvalCase({ id: "../escape" })).toThrow();
		expect(() => parseJudgeVerdict({ score: 5, reason: "ok", evidence_refs: ["missing"] }, ["execution-output"])).toThrow();
		expect(aggregateEvalStatus(["PASS", "INCONCLUSIVE"])).toBe("INCONCLUSIVE");
	});

	test("keeps eval output bounded and never grants task completion", async () => {
		const report = await evaluateCase({ id: "bounded", version: 1, kind: "functional", task: "test", timeout_ms: 1000, max_tokens: 100, expect: [{ type: "contains", value: "PASS" }] }, async () => ({ output: "PASS", exitCode: 0, tokens: 1 }));
		expect(report.status).toBe("PASS");
		expect(report.completionAllowed).toBe(false);
		expect(report.evidence[0].sha256).toHaveLength(64);
	});

	test("routes verification failures by cause and escalates repeated attempts", () => {
		expect(workflowDirection({ status: "FAIL", failure: "implementation" }).next).toBe("BUILD");
		expect(workflowDirection({ status: "FAIL", failure: "requirements" }).next).toBe("SPEC");
		expect(workflowDirection({ status: "FAIL", attempt: 3 }).next).toBe("ASK_USER");
		expect(workflowDirection({ status: "UNVERIFIED", risk: "high" }).autonomy).toBe("interactive");
	});

	test("generates context facts without executing commands and detects drift", () => {
		const cwd = mkdtempSync(join(tmpdir(), "agent-pi-context-"));
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "npm test" } }));
		writeFileSync(join(cwd, "CLAUDE.md"), "rule\n");
		const first = inspectProjectContext(cwd);
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "npm run check" } }));
		const second = inspectProjectContext(cwd);
		const drift = contextDrift(first.snapshot, second.snapshot);
		expect(drift.changedFiles).toContain("package.json");
		expect(drift.changedCommands).toContain("test");
		expect(first.draft).toContain("not executed or verified");
	});

	test("triages only bounded workspace logs and fails closed for sensitive paths", () => {
		const cwd = mkdtempSync(join(tmpdir(), "agent-pi-log-"));
		writeFileSync(join(cwd, "service.log"), "2026-01-01T00:00:00Z error token=secret\n2026-01-01T00:00:01Z error token=secret\n");
		const report = inspectLog(cwd, "service.log");
		expect(report.issues).toHaveLength(1);
		expect(report.issues[0].sample).toContain("[REDACTED]");
		expect(() => inspectLog(cwd, ".env")).toThrow();
	});

	test("requires evidence for deployment readiness and redacts artifacts", () => {
		const cwd = mkdtempSync(join(tmpdir(), "agent-pi-artifact-"));
		const blocked = deploymentGate([{ name: "tests", required: true, status: "PASS" }]);
		expect(blocked.status).toBe("BLOCKED");
		expect(blocked.deploymentAllowed).toBe(false);
		const path = saveArtifact(cwd, "test", { token: "secret", email: "user@example.com" }, "fixture");
		const content = readFileSync(path, "utf8");
		expect(content).toContain("[REDACTED]");
		expect(content).toContain("[REDACTED EMAIL]");
		expect(redactEvidence("Bearer abc")).toContain("[REDACTED]");
	});

	test("writes and searches a bounded workspace-scoped retrospective", () => {
		const cwd = mkdtempSync(join(tmpdir(), "workflow-retrospective-"));
		const path = saveRetrospective(cwd, { runId: "chain-run-1", actor: "chain:test", mode: "CHAIN", status: "succeeded", durationMs: 42, stepsUsed: 2, usage: { totalTokens: 12, costUsd: 0.01 }, evidenceRefs: ["run:event:1"] });
		expect(path).toContain(".pi/workflow/retrospectives/chain-run-1.json");
		const hit = searchRetrospectives(cwd, "chain-run-1")[0];
		expect(hit).toMatchObject({ run_id: "chain-run-1", trust: "untrusted historical evidence" });
		// Facts-only records never fabricate experience.
		expect(hit.experience).toEqual({ available: false, generator: null });
		expect(hit.facts.terminal_status).toBe("succeeded");
	});

	test("insights keep kind and lifecycle; rejected and stale never re-enter context", () => {
		const cwd = mkdtempSync(join(tmpdir(), "workflow-insights-"));
		saveRetrospective(cwd, { runId: "chain-run-2", actor: "chain:test", status: "failed", durationMs: 5, stepsUsed: 1, usage: { totalTokens: 3, costUsd: 0 }, evidenceRefs: ["e1"] });
		augmentRetrospective(cwd, "chain-run-2", [
			{ id: "insight-1", kind: "hypothesis", text: "Resource waves serialized the conflict", evidence_refs: ["e1"], status: "active" },
			{ id: "rule-1", kind: "rule_draft", text: "Consider pinning resource locks", evidence_refs: ["e1"], status: "active" },
			{ id: "bad", kind: "fact", text: "", evidence_refs: [], status: "active" },
		], "model:fixture");
		const hit = searchRetrospectives(cwd, "serialized")[0];
		expect(hit.experience.available).toBe(true);
		expect(hit.insights).toHaveLength(2);
		markInsight(cwd, "chain-run-2", "insight-1", "stale");
		// The staled hypothesis no longer matches; the active rule draft remains.
		expect(searchRetrospectives(cwd, "serialized")).toHaveLength(0);
		expect(searchRetrospectives(cwd, "pinning")[0].insights).toHaveLength(1);
		expect(searchRetrospectives(cwd, "pinning")[0].insights[0].kind).toBe("rule_draft");
		markInsight(cwd, "chain-run-2", "rule-1", "adopted");
		expect(searchRetrospectives(cwd, "pinning")[0].insights[0].status).toBe("adopted");
	});

	test("listing and explicit clear stay bounded and user-driven", () => {
		const cwd = mkdtempSync(join(tmpdir(), "workflow-retention-"));
		saveRetrospective(cwd, { runId: "run-a", actor: "task", status: "succeeded", durationMs: 1, stepsUsed: 1, usage: { totalTokens: 1, costUsd: 0 }, evidenceRefs: [] });
		saveRetrospective(cwd, { runId: "run-b", actor: "task", status: "cancelled", durationMs: 1, stepsUsed: 1, usage: { totalTokens: 1, costUsd: 0 }, evidenceRefs: [] });
		expect(listRetrospectives(cwd)).toHaveLength(2);
		expect(clearRetrospectives(cwd, "run-a")).toBe(1);
		expect(listRetrospectives(cwd)).toHaveLength(1);
		expect(listRetrospectives(cwd)[0].run_id).toBe("run-b");
	});
});
