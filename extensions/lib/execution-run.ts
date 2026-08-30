// ABOUTME: Minimal durable run directory for execution contracts.
// ABOUTME: Uses atomic JSON writes and append-only events without introducing a new workflow mode.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GoalContract } from "./execution-contract.ts";
import type { VerifierReceipt } from "./verifier-runtime.ts";
import { recordRunEvent } from "./evidence-store.ts";

let activeRun: string | undefined;
export function setActiveRun(runDir: string): void { activeRun = runDir; }
export function activeRunDirectory(): string | undefined { return activeRun; }
export function clearActiveRun(): void { activeRun = undefined; }

export function runDirectory(baseDir: string, runId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(runId)) throw new Error("Invalid run id");
  return join(baseDir, runId);
}

export function saveGoal(runDir: string, goal: GoalContract): void {
  mkdirSync(runDir, { recursive: true });
  const target = join(runDir, "goal.json");
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(goal, null, 2) + "\n", "utf8");
  renameSync(tmp, target);
}

export function loadGoal(runDir: string): GoalContract | undefined {
  try { return JSON.parse(readFileSync(join(runDir, "goal.json"), "utf8")) as GoalContract; } catch { return undefined; }
}

export function saveVerifierReceipt(runDir: string, receipt: VerifierReceipt): void {
  mkdirSync(runDir, { recursive: true });
  const target = join(runDir, "verifier-receipt.json");
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  renameSync(tmp, target);
}

export function loadVerifierReceipt(runDir: string): VerifierReceipt | undefined {
  try { return JSON.parse(readFileSync(join(runDir, "verifier-receipt.json"), "utf8")) as VerifierReceipt; } catch { return undefined; }
}

export function initializeRun(baseDir: string, goal: GoalContract): string {
  const dir = runDirectory(baseDir, goal.id);
  saveGoal(dir, goal);
  setActiveRun(dir);
  recordRunEvent(dir, { id: `${goal.id}-created`, type: "goal_created", actor: "runtime", timestamp: new Date().toISOString(), payload: { objective: goal.objective } });
  return dir;
}


export function latestVerifierReceipt(baseDir: string): { goal: GoalContract; receipt: VerifierReceipt; runDir: string } | undefined {
  try {
    const dirs = readdirSync(baseDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => join(baseDir, e.name));
    dirs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const runDir of dirs) {
      const goal = loadGoal(runDir);
      const receipt = loadVerifierReceipt(runDir);
      if (goal && receipt) return { goal, receipt, runDir };
    }
  } catch {}
  return undefined;
}
