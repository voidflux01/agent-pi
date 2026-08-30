import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeRun, loadGoal, loadVerifierReceipt, saveVerifierReceipt } from "../lib/execution-run.ts";
import { verifierAction } from "../lib/verification-policy.ts";

describe("execution run persistence", () => {
  it("persists a goal and creation event in a bounded run directory", () => {
    const base = mkdtempSync(join(tmpdir(), "execution-run-"));
    const goal = { version: 1 as const, id: "run-1", objective: "x", scope: [], constraints: [], successCriteria: ["y"], evidenceRequired: [], risks: [], subgoals: [], status: "draft" as const };
    const dir = initializeRun(base, goal);
    expect(loadGoal(dir)?.objective).toBe("x");
    expect(readFileSync(join(dir, "events.jsonl"), "utf8")).toContain("goal_created");
    expect(() => initializeRun(base, { ...goal, id: "../escape" })).toThrow();
    const receipt = { version: 1 as const, status: "PASS" as const, objectiveHash: "h", criteria: [{ criterion: "y", status: "pass" as const, evidenceIds: [] }], commandsRun: [], changedFiles: [], blockers: [], attempt: 1, createdAt: "now" };
    saveVerifierReceipt(dir, receipt);
    expect(loadVerifierReceipt(dir)?.status).toBe("PASS");
    writeFileSync(join(dir, "verifier-receipt.json"), JSON.stringify({ version: 1, status: "PASS", objectiveHash: "h", criteria: [], changedFiles: [], attempt: 0 }));
    expect(loadVerifierReceipt(dir)).toBeUndefined();
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
