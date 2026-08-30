// ABOUTME: Automatically journals completed bash/test tool calls for the active execution run.
// ABOUTME: Captures bounded runtime output; it never changes the verifier completion decision.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { activeRunDirectory, clearActiveRun } from "./lib/execution-run.ts";
import { recordEvidence } from "./lib/evidence-store.ts";

const MAX_OUTPUT = 8_000;
import { redactSensitive } from "./lib/sensitive-data.ts";

export const redact = redactSensitive;

const starts = new Map<string, { command: string; startedAt: number; runDir: string }>();

function output(result: any): string {
  if (typeof result === "string") return result;
  if (Array.isArray(result?.content)) return result.content.filter((x: any) => x?.type === "text").map((x: any) => x.text).join("\n");
  return JSON.stringify(result ?? "");
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => { clearActiveRun(); });
  (pi.on as any)("session_switch", async () => { clearActiveRun(); });
  pi.on("tool_execution_start", async (event: any) => {
    if (!activeRunDirectory() || !["bash", "run_tests"].includes(event.toolName)) return;
    const command = redactSensitive(String(event.args?.command || event.args?.cmd || event.args?.script || "").slice(0, 2_000));
    starts.set(event.toolCallId, { command, startedAt: Date.now(), runDir: activeRunDirectory()! });
  });
  pi.on("tool_execution_end", async (event: any) => {
    const start = starts.get(event.toolCallId); if (!start) return;
    starts.delete(event.toolCallId);
    const text = output(event.result);
    const details = event.result?.details || {};
    recordEvidence(start.runDir, { id: `runtime-${Date.now().toString(36)}`, type: event.toolName === "run_tests" ? "test" : "command", source: "runtime", value: JSON.stringify({ command: start.command, exitCode: details.exitCode ?? (event.isError ? 1 : 0), output: redactSensitive(text).slice(-MAX_OUTPUT), durationMs: Date.now() - start.startedAt }), timestamp: new Date().toISOString() });
  });
}
