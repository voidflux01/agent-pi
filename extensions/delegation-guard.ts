// ABOUTME: Delegation guard - blocks model-driven shadow fleets.
// ABOUTME: A bash call that spawns headless pi bypasses dispatch_agent:
// ABOUTME no journal row, no herdr visibility, no RESULT contract, no
// ABOUTME archived transcript. Blocked with guidance to use team tools.
// ABOUTME Opt out with PI_DELEGATION_GUARD=0.

import { probeNestedPiLaunch } from "./lib/delegation-guard.ts";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { recordBlockedToolCall } from "./orchestration-tool-audit.ts";

export default function delegationGuard(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (process.env.PI_DELEGATION_GUARD === "0") return { block: false };
		if (event.toolName !== "bash") return { block: false };
		const params = event.arguments || event.params || event.input || {};
		const cmd = String(params.command || params.cmd || "");
		if (!cmd || !probeNestedPiLaunch(cmd)) return { block: false };
		recordBlockedToolCall({ toolCallId: event.toolCallId, toolName: event.toolName, category: "delegation_guard", reason: "nested pi launch", context: ctx });
		return {
			block: true,
			reason: [
				"Blocked: launching headless pi from bash bypasses the sub-agent infrastructure",
				"(no task-journal entry, no herdr tab, no ## RESULT contract, no transcript archive).",
				"",
				"Do one of these instead:",
				"- delegate with the dispatch_agent tool (single agent),",
				"  run_chain/dispatch_agents for chains/pipelines, or subagent_create.",
				"- if you truly need a bare process here, ask the user to set PI_DELEGATION_GUARD=0.",
			].join("\n"),
		};
	});
}
