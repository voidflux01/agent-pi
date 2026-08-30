import { describe, expect, it } from "vitest";
import { completionDecision, verificationRequired } from "../lib/execution-gate.ts";
import type { GoalContract } from "../lib/execution-contract.ts";
import { objectiveHash } from "../lib/execution-contract.ts";
import { workspaceHash } from "../lib/verifier-runtime.ts";

const goal = (): GoalContract => ({ version: 1, id: "g", objective: "x", scope: [], constraints: [], successCriteria: ["y"], evidenceRequired: [], risks: [], subgoals: [], status: "approved" });
const receipt = (g: GoalContract) => ({ version: 1 as const, status: "PASS" as const, objectiveHash: objectiveHash(g), criteria: [{ criterion: "y", status: "pass" as const, evidenceIds: ["e"] }], commandsRun: [], changedFiles: [], blockers: [], attempt: 1, createdAt: "now" });

describe("execution completion gate", () => {
  it("requires verification for write-capable orchestrated modes", () => {
    expect(verificationRequired("PLAN", true)).toBe(true);
    expect(verificationRequired("TEAM", true)).toBe(true);
    expect(verificationRequired("NORMAL", true)).toBe(false);
    expect(verificationRequired("PLAN", false)).toBe(false);
  });
  it("accepts only a receipt bound to the current goal", () => {
    const g = goal();
    expect(completionDecision({ mode: "PIPELINE", hasWrites: true }).allowed).toBe(false);
    expect(completionDecision({ mode: "PIPELINE", hasWrites: true, goal: g, receipt: receipt(g) }).allowed).toBe(true);
    expect(completionDecision({ mode: "PIPELINE", hasWrites: true, goal: g, receipt: { ...receipt(g), objectiveHash: "stale" } }).allowed).toBe(false);
    const r = { ...receipt(g), workspaceHash: workspaceHash("old", ["a.ts"]) };
    expect(completionDecision({ mode: "PIPELINE", hasWrites: true, goal: g, receipt: r, workspaceHash: workspaceHash("new", ["a.ts"]) }).allowed).toBe(false);
  });
});
