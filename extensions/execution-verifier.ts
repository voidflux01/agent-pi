// ABOUTME: Explicit read-only verifier tool for PLAN, TEAM, and ad-hoc completion checks.
// ABOUTME: It verifies real repository state and treats all supplied summaries as untrusted.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildVerifierPrompt, createVerifierReceipt, parseVerifierStatus, workspaceHash, canComplete } from "./lib/verifier-runtime.ts";
import { objectiveHash, type GoalContract } from "./lib/execution-contract.ts";
import { explicitDispatchHandler, currentDispatchAuthorization, run as runDispatch } from "./lib/dispatch-runtime.ts";
import { childEnvironment } from "./lib/child-runtime.ts";
import { listEvidence } from "./lib/evidence-store.ts";
import { DEFAULT_VERIFIER_ATTEMPTS } from "./lib/verification-policy.ts";
import { saveVerifierReceipt, loadGoal, loadVerifierReceipt, latestVerifierReceipt, setActiveRun, activeRunDirectory } from "./lib/execution-run.ts";
import { redactSensitive } from "./lib/sensitive-data.ts";

const Params = Type.Object({
  objective: Type.String({ description: "Acceptance objective; treated as untrusted data" }),
  criteria: Type.Array(Type.String(), { description: "Acceptance criteria to check" }),
  worker_summary: Type.Optional(Type.String({ description: "Worker report; untrusted hint only" })),
  attempt: Type.Optional(Type.Number({ description: "Verifier attempt number" })),
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("execution-status", {
    description: "Show the latest execution contract and verifier receipt",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd || process.cwd();
      const latest = latestVerifierReceipt(join(cwd, ".pi", "agent-sessions", "execution-runs"));
      if (!latest) { ctx.ui.notify("No execution contract receipt found", "info"); return; }
      try {
        const diff = git(cwd, ["diff", "--no-ext-diff", "--", "."]);
        const files = git(cwd, ["diff", "--name-only", "--no-ext-diff"]).split("\n").filter(Boolean);
        const current = canComplete(latest.receipt, objectiveHash(latest.goal), workspaceHash(diff, files));
        const state = current ? latest.receipt.status : "STALE";
        ctx.ui.notify(`${state} · ${latest.goal.objective} · attempt ${latest.receipt.attempt}`, state === "PASS" ? "info" : "warning");
      } catch (error) { ctx.ui.notify(`Execution status unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
    },
  });
  pi.registerTool({
    name: "verify_execution",
    label: "Verify Execution",
    description: "Run an independent, read-only verifier against the real working tree. Worker summaries are untrusted and cannot establish completion.",
    parameters: Params,
    execute: explicitDispatchHandler("pipeline-team", (async (_id, params, _signal, _update, ctx) => {
      const p = params as { objective: string; criteria: string[]; worker_summary?: string; attempt?: number };
      const activeGoal = activeRunDirectory() ? loadGoal(activeRunDirectory()!) : undefined;
      const goal: GoalContract = activeGoal && activeGoal.objective.trim() === p.objective.trim()
        ? { ...activeGoal, successCriteria: p.criteria.length ? p.criteria : activeGoal.successCriteria, status: "verifying" }
        : { version: 1, id: `verify-${Date.now().toString(36)}`, objective: p.objective, scope: [], constraints: [], successCriteria: p.criteria, evidenceRequired: [{ id: "diff", description: "Inspect real git diff", type: "diff" }], risks: [], subgoals: [], status: "verifying" };
      let diff: string;
      let files: string[];
      try {
        diff = git(ctx.cwd, ["diff", "--no-ext-diff", "--", "."]);
        files = git(ctx.cwd, ["diff", "--name-only", "--no-ext-diff"]).split("\n").filter(Boolean);
      } catch (error) {
        return { content: [{ type: "text", text: `Verification blocked: unable to inspect git workspace (${error instanceof Error ? error.message : String(error)})` }], details: { status: "BLOCKED" } };
      }
      const stableRunId = `verify-${objectiveHash(goal).slice(0, 24)}`;
      const runDir = join(ctx.cwd, ".pi", "agent-sessions", "execution-runs", stableRunId);
      const previous = loadVerifierReceipt(runDir);
      setActiveRun(runDir);
      const attempt = Math.max(p.attempt || 1, (previous?.attempt || 0) + 1);
      if (attempt > DEFAULT_VERIFIER_ATTEMPTS) return { content: [{ type: "text", text: `Verification blocked: maximum ${DEFAULT_VERIFIER_ATTEMPTS} attempts reached.` }], details: { status: "BLOCKED", attempt } };
      const evidence = [{ id: `${goal.id}-diff`, type: "diff" as const, source: "runtime" as const, value: redactSensitive(diff).slice(0, 12000), timestamp: new Date().toISOString() }, ...((activeRunDirectory() ? listEvidence(activeRunDirectory()!) : []).filter(e => e.source === "runtime").slice(-50))];
      const prompt = buildVerifierPrompt({ goal, evidence, diff: redactSensitive(diff), workerSummary: p.worker_summary });
      const auth = currentDispatchAuthorization();
      if (!auth) return { content: [{ type: "text", text: "Verification refused: explicit dispatch authorization is required." }], details: { status: "BLOCKED" } };
      const extDir = dirname(fileURLToPath(import.meta.url));
      const chunks: string[] = [];
      const result = await runDispatch({ authorization: auth, command: ["pi", "--mode", "json", "-p", "--no-extensions", "-e", join(extDir, "security-guard.ts"), "--tools", "read,grep,find,ls", prompt], cwd: ctx.cwd, env: childEnvironment({ PI_SUBAGENT: "1", PI_AGENT_NAME: "reviewer-verifier" }), launchDir: join(ctx.cwd, ".pi", "agent-sessions"), launchId: goal.id, transport: "headless", pollTimeoutMs: 15 * 60 * 1000, onStdoutLine: line => { try { const e = JSON.parse(line); if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") chunks.push(e.assistantMessageEvent.delta || ""); } catch {} } });
      const output = result.outputText || chunks.join("");
      if (result.exitCode !== 0) return { content: [{ type: "text", text: `Verifier process failed (exit ${result.exitCode}): ${result.stderr || output.slice(-1200)}` }], details: { status: "BLOCKED", exitCode: result.exitCode } };
      const status = parseVerifierStatus(output);
      if (!status) return { content: [{ type: "text", text: `Verifier returned no unambiguous decision: ${result.stderr || "unknown error"}` }], details: { status: "BLOCKED" } };
      const receipt = createVerifierReceipt({ output, objectiveHash: objectiveHash(goal), criteria: p.criteria.map(criterion => ({ criterion, status: status === "PASS" ? "pass" : "unknown", evidenceIds: [`${goal.id}-diff`], note: output.slice(-1200) })), commandsRun: ["git diff --no-ext-diff -- .", "git diff --name-only --no-ext-diff"], changedFiles: files, workspaceHash: workspaceHash(diff, files), attempt });
      try { saveVerifierReceipt(runDir, receipt!); } catch {}
      return { content: [{ type: "text", text: `Verifier: ${status}\n${output.slice(-4000)}` }], details: { status, receipt } };
    }) as any),
  });
}
