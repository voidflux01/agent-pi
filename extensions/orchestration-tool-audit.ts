// ABOUTME: Audits native Pi tool executions into the shared orchestration event model.
// ABOUTME: Keeps direct NORMAL/PLAN/SPEC work observable alongside composed and worker calls.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { coordinationState } from "./lib/coordination-state.ts";
import { getCapabilityForTool } from "./lib/capability-registry.ts";
import { createOrchestrationRun, type OrchestrationRun } from "./lib/orchestration-run.ts";

type PendingExecution = { toolName: string; run: OrchestrationRun };

const BLOCKED_CALLS_KEY = "__piAuditedBlockedToolCalls";

function inheritedParentRunId(): string | undefined {
	const value = process.env.PI_AGENT_PI_RUN_ID;
	return typeof value === "string" && /^[A-Za-z0-9-]{1,80}$/.test(value) ? value : undefined;
}

/** Persist one bounded rejection without letting stacked gates double-count it. */
export function recordBlockedToolCall(input: {
	toolCallId: string;
	toolName: string;
	reason?: string;
	category: string;
	context?: any;
}): string | undefined {
	const g = globalThis as any;
	const seen: Set<string> = g[BLOCKED_CALLS_KEY] instanceof Set ? g[BLOCKED_CALLS_KEY] : (g[BLOCKED_CALLS_KEY] = new Set<string>());
	if (seen.has(input.toolCallId)) return undefined;
	seen.add(input.toolCallId);
	if (seen.size > 2048) {
		const oldest = seen.values().next().value;
		if (typeof oldest === "string") seen.delete(oldest);
	}
	const run = createOrchestrationRun({
		context: input.context,
		parentRunId: inheritedParentRunId(),
		actor: "tool-gate",
		mode: coordinationState().mode,
		budget: { maxSteps: 1 },
		workspaceCwd: undefined,
	});
	run.consumeStep();
	run.record("tool.blocked", {
		toolName: input.toolName,
		toolCallId: input.toolCallId,
		category: input.category,
		reason: typeof input.reason === "string" ? input.reason.slice(0, 512) : undefined,
	});
	run.finish("failed", { toolName: input.toolName, toolCallId: input.toolCallId, category: input.category });
	return run.runId;
}

function shouldCaptureWorkspace(toolName: string): boolean {
	const capability = getCapabilityForTool(toolName);
	return toolName === "write" || toolName === "edit" || toolName === "bash"
		|| capability?.effect.resources?.includes("workspace") === true;
}

export default function (pi: ExtensionAPI) {
	const pending = new Map<string, PendingExecution>();

	pi.on("tool_execution_start", (event, ctx) => {
		// call_tool already owns a nested RunContext so its proxied lifecycle is not
		// double-counted here. Native and extension tools still use this common path.
		if (event.toolName === "call_tool") return;
		const run = createOrchestrationRun({
			context: ctx,
			parentRunId: inheritedParentRunId(),
			actor: "tool-runtime",
			mode: coordinationState().mode,
			budget: { maxSteps: 1 },
			workspaceCwd: shouldCaptureWorkspace(event.toolName) ? (ctx?.cwd || process.cwd()) : undefined,
		});
		run.consumeStep();
		run.record("tool.started", { toolName: event.toolName, toolCallId: event.toolCallId });
		pending.set(event.toolCallId, { toolName: event.toolName, run });
	});

	pi.on("tool_execution_end", (event) => {
		const execution = pending.get(event.toolCallId);
		if (!execution) return;
		pending.delete(event.toolCallId);
		const resultDetails = event.result?.details;
		const cancelled = resultDetails?.cancelled === true || resultDetails?.status === "cancelled";
		const status = cancelled ? "cancelled" : event.isError ? "failed" : "succeeded";
		execution.run.record("tool.completed", {
			toolName: execution.toolName,
			toolCallId: event.toolCallId,
			status,
			isError: event.isError,
		});
		execution.run.finish(status, { toolName: execution.toolName, toolCallId: event.toolCallId });
	});
}
