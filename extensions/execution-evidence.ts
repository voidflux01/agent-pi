// ABOUTME: Explicit command/test evidence journal for execution runs.
// ABOUTME: Captures worker-reported command metadata as untrusted claims; verifiers must rerun checks.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { join } from "node:path";
import { recordEvidence } from "./lib/evidence-store.ts";

const SECRET_PATTERNS = [/(sk-[A-Za-z0-9_-]{12,})/g, /(AKIA[0-9A-Z]{16})/g, /((?:token|secret|password|passwd|api[_-]?key)\s*[=:]\s*)([^\s,;]+)/gi, /(Bearer\s+)[A-Za-z0-9._~-]+/gi];
function redact(value: string): string { return SECRET_PATTERNS.reduce((text, pattern) => text.replace(new RegExp(pattern.source, pattern.flags), (match, prefix?: string) => prefix && prefix !== match ? `${prefix}[REDACTED]` : "[REDACTED]"), value); }

const Params = Type.Object({
  run_id: Type.String({ description: "Execution run id" }),
  kind: Type.Union([Type.Literal("command"), Type.Literal("test")]),
  command: Type.String(),
  exit_code: Type.Number(),
  stdout: Type.Optional(Type.String()),
  stderr: Type.Optional(Type.String()),
  duration_ms: Type.Optional(Type.Number()),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "record_execution_evidence",
    label: "Record Execution Evidence",
    description: "Record command/test metadata for an execution run. This is explicitly an untrusted worker claim and never proves completion by itself.",
    parameters: Params,
    async execute(_id, params, _signal, _update, ctx) {
      const p = params as { run_id: string; kind: "command" | "test"; command: string; exit_code: number; stdout?: string; stderr?: string; duration_ms?: number };
      if (!/^[a-zA-Z0-9._-]+$/.test(p.run_id)) return { content: [{ type: "text", text: "Invalid run_id." }], details: { error: true } };
      const value = JSON.stringify({ command: redact(p.command.slice(0, 2000)), exitCode: p.exit_code, stdout: redact(p.stdout || "").slice(-8000), stderr: redact(p.stderr || "").slice(-8000), durationMs: p.duration_ms });
      const runDir = join(ctx.cwd || process.cwd(), ".pi", "agent-sessions", "execution-runs", p.run_id);
      const evidence = { id: `claim-${Date.now().toString(36)}`, type: p.kind, source: "worker_claim" as const, value, timestamp: new Date().toISOString() };
      recordEvidence(runDir, evidence);
      return { content: [{ type: "text", text: `Recorded untrusted ${p.kind} evidence claim ${evidence.id}.` }], details: evidence };
    },
  });
}
