import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deploymentGate, inspectLog } from "../lib/workflow-monitor.ts";

describe("workflow monitor", () => {
	test("groups repeated failures by fingerprint with severity, frequency and evidence refs", () => {
		const cwd = mkdtempSync(join(tmpdir(), "agent-pi-monitor-"));
		const log = [
			"2026-09-01T10:00:00Z error db timeout 42",
			"2026-09-01T10:00:01Z error db timeout 43",
			"2026-09-01T10:00:02Z fatal disk full on /",
			"2026-09-01T10:00:03Z warn cache stale",
			"2026-09-01T10:00:04Z all good, nothing to see",
		].join("\n");
		writeFileSync(join(cwd, "service.log"), log);
		const report = inspectLog(cwd, "service.log");
		expect(report.issues).toHaveLength(3);
		const db = report.issues.find(i => i.sample.includes("db timeout"))!;
		expect(db.frequency).toBe(2);
		expect(db.severity).toBe("medium");
		expect(db.evidence_refs).toContain("tail-line:1");
		expect(report.issues.find(i => i.severity === "high")!.sample).toContain("disk full");
		expect(report.scanned_lines).toBe(5);
		expect(report.uncertainty).toContain("does not prove service health");
	});

	test("normalizes volatile tokens into stable fingerprints", () => {
		const cwd = mkdtempSync(join(tmpdir(), "agent-pi-monitor-"));
		writeFileSync(join(cwd, "app.log"), "error req 123 uuid 550e8400-e29b-41d4-a716-446655440000\nerror req 999 uuid 550e8400-e29b-41d4-a716-446655440001\n");
		const report = inspectLog(cwd, "app.log");
		expect(report.issues).toHaveLength(1);
	});

	test("redacts secrets in samples and evidence", () => {
		const cwd = mkdtempSync(join(tmpdir(), "agent-pi-monitor-"));
		writeFileSync(join(cwd, "app.log"), "error token=\"abc123\" from 10.0.0.5\n");
		const report = inspectLog(cwd, "app.log");
		expect(report.issues[0].sample).toContain("[REDACTED]");
		expect(report.issues[0].sample).not.toContain("abc123");
	});

	test("rejects sensitive log paths outright", () => {
		const cwd = mkdtempSync(join(tmpdir(), "agent-pi-monitor-"));
		for (const path of [".env", ".ssh/authorized_keys", "aws/secrets", "credentials.json", "sub/.env.production"]) {
			expect(() => inspectLog(cwd, path)).toThrow("Sensitive log path rejected");
		}
	});

	test("deployment gate blocks on missing or evidence-less required checks and never authorizes", () => {
		expect(deploymentGate([{ name: "tests", required: true, status: "PASS" }]).status).toBe("BLOCKED");
		expect(deploymentGate([{ name: "tests", required: true, status: "FAIL", evidence_ref: "r1" }]).blockers).toContain("tests");
		const ready = deploymentGate([
			{ name: "tests", required: true, status: "PASS", evidence_ref: "evals/run-1.json" },
			{ name: "nice-to-have", required: false, status: "INCONCLUSIVE" },
		]);
		expect(ready.status).toBe("READY_FOR_REVIEW");
		expect(ready.deploymentAllowed).toBe(false);
		expect(() => deploymentGate([])).toThrow();
	});
});
