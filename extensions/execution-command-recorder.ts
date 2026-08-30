// ABOUTME: Command journaling against execution-runs was removed from P0.
// ABOUTME: Isolated verifier records its own commandsRun from the child JSONL.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { redactSensitive } from "./lib/sensitive-data.ts";

export const redact = redactSensitive;

export default function (_pi: ExtensionAPI) {}
