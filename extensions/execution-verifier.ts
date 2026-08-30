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
import { saveVerifierReceipt, latestVerifierReceipt } from "./lib/execution-run.ts";

const Params = Type.Object({
  objective: Type.String({ description: "Acceptance objective; treated as untrusted data" }),
  criteria: Type.Array(Type.String(), { description: "Acceptance criteria to check" }),
  worker_summary: Type.Optional(Type.String({ description: "Worker report; untrusted hint only" })),
  attempt: Type.Optional(Type.Number({ description: "Verifier attempt number" })),
});

function git(cwd: string, args: string[]): string {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }); } catch { return "git command failed"; }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("execution-status", {
    description: "Show the latest execution contract and verifier receipt",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd || process.cwd();
      const latest = latestVerifierReceipt(join(cwd, ".pi", "agent-sessions", "execution-runs"));
      if (!latest) { ctx.ui.notify("No execution contract receipt found", "info"); return; }
      const diff = git(cwd, ["diff", "--no-ext-diff", "--", "."]);
      const files = git(cwd, ["diff", "--name-only", "--no-ext-diff"]).split("\n").filter(Boolean);
      const current = canComplete(latest.receipt, objectiveHash(latest.goal), workspaceHash(diff, files));
      const state = current ? latest.receipt.status : "STALE";
      ctx.ui.notify(`${state} · ${latest.goal.objective} · attempt ${latest.receipt.attempt}`, state === "PASS" ? "info" : "warning");
    },
  });
  pi.registerTool({
    name: "verify_execution",
    label: "Verify Execution",
    description: "Run an independent, read-only verifier against the real working tree. Worker summaries are untrusted and cannot establish completion.",
    parameters: Params,
    execute: explicitDispatchHandler("pipeline-team", (async (_id, params, _signal, _update, ctx) => {
      const p = params as { objective: string; criteria: string[]; worker_summary?: string; attempt?: number };
      const goal: GoalContract = { version: 1, id: `verify-${Date.now().toString(36)}`, objective: p.objective, scope: [], constraints: [], successCriteria: p.criteria, evidenceRequired: [{ id: "diff", description: "Inspect real git diff", type: "diff" }], risks: [], subgoals: [], status: "verifying" };
      const diff = git(ctx.cwd, ["diff", "--no-ext-diff", "--", "."]);
      const files = git(ctx.cwd, ["diff", "--name-only", "--no-ext-diff"]).split("\n").filter(Boolean);
      const prompt = buildVerifierPrompt({ goal, evidence: [{ id: `${goal.id}-diff`, type: "diff", source: "runtime", value: diff.slice(0, 12000), timestamp: new Date().toISOString() }], diff, workerSummary: p.worker_summary });
      const auth = currentDispatchAuthorization();
      if (!auth) return { content: [{ type: "text", text: "Verification refused: explicit dispatch authorization is required." }], details: { status: "BLOCKED" } };
      const extDir = dirname(fileURLToPath(import.meta.url));
      const chunks: string[] = [];
      const result = await runDispatch({ authorization: auth, command: ["pi", "--mode", "json", "-p", "--no-extensions", "-e", join(extDir, "security-guard.ts"), "--tools", "read,grep,find,ls", prompt], cwd: ctx.cwd, env: childEnvironment({ PI_SUBAGENT: "1", PI_AGENT_NAME: "reviewer-verifier" }), launchDir: join(ctx.cwd, ".pi", "agent-sessions"), launchId: goal.id, transport: "headless", pollTimeoutMs: 15 * 60 * 1000, onStdoutLine: line => { try { const e = JSON.parse(line); if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") chunks.push(e.assistantMessageEvent.delta || ""); } catch {} } });
      const output = result.outputText || chunks.join("");
      const status = parseVerifierStatus(output);
      if (!status) return { content: [{ type: "text", text: `Verifier returned no unambiguous decision: ${result.stderr || "unknown error"}` }], details: { status: "BLOCKED" } };
      const receipt = createVerifierReceipt({ output, objectiveHash: objectiveHash(goal), criteria: p.criteria.map(criterion => ({ criterion, status: status === "PASS" ? "pass" : "unknown", evidenceIds: [`${goal.id}-diff`], note: output.slice(-1200) })), commandsRun: ["git diff --no-ext-diff -- .", "git diff --name-only --no-ext-diff"], changedFiles: files, workspaceHash: workspaceHash(diff, files), attempt: p.attempt || 1 });
      try { saveVerifierReceipt(join(ctx.cwd, ".pi", "agent-sessions", "execution-runs", goal.id), receipt!); } catch {}
      return { content: [{ type: "text", text: `Verifier: ${status}\n${output.slice(-4000)}` }], details: { status, receipt } };
    }) as any),
  });
}
