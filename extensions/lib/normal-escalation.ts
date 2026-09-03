// ABOUTME: Runtime guard that nudges NORMAL out of unbounded read-only exploration.
// ABOUTME: Keeps simple work frictionless while requiring a low-cost scout after a recon loop.

import { isReconTool } from "./tool-classification.ts";
import { isReconBash } from "./tool-invocation.ts";

export const NORMAL_RECON_TOOLS = ["read", "grep", "ffgrep", "find", "ls", "glob"] as const;
export const NORMAL_RECON_LIMIT = 8;
export const RECON_ESCALATION_LIMIT = NORMAL_RECON_LIMIT;

export interface NormalEscalationState {
	consecutiveReconCalls: number;
}

export function createNormalEscalationState(): NormalEscalationState {
	return { consecutiveReconCalls: 0 };
}

export function resetNormalEscalation(state: NormalEscalationState): void {
	state.consecutiveReconCalls = 0;
}

export function isNormalReconTool(toolName: string): boolean {
	return isReconTool(toolName);
}

/** Conservative classification for shell-based repository reconnaissance. */
export function isNormalReconCall(toolName: string, args?: unknown): boolean {
	if (isNormalReconTool(toolName)) return true;
	if (toolName !== "bash") return false;
	return isReconBash(args);
}

/**
 * Record one NORMAL tool call. A blocked call leaves the counter at the limit
 * so repeated inspection stays blocked until the parent dispatches a scout or
 * takes another non-recon action.
 */
export function recordNormalToolCall(
	state: NormalEscalationState,
	toolName: string,
	args?: unknown,
): { block: boolean; count: number } {
	if (!isNormalReconCall(toolName, args)) {
		resetNormalEscalation(state);
		return { block: false, count: 0 };
	}

	state.consecutiveReconCalls++;
	const block = state.consecutiveReconCalls >= NORMAL_RECON_LIMIT;
	return { block, count: state.consecutiveReconCalls };
}

export function normalEscalationReason(count: number): string {
	return `NORMAL escalation: ${count} consecutive read-only inspection calls have not resolved the task. Before more repository searching, dispatch one read-only SCOUT with subagent_create (name: "scout"). If the scout resolves the uncertainty, continue in NORMAL; switch to PLAN only if the scope or implementation approach now needs review.`;
}

export function reconEscalationReason(mode: string, count: number): string {
	const normalized = String(mode || "NORMAL").toUpperCase();
	if (normalized === "NORMAL") return normalEscalationReason(count);
	return `${normalized} escalation: ${count} consecutive read-only inspection calls have not resolved the task. Before more repository searching, dispatch one fresh read-only SCOUT with subagent_create (name: "scout") for the current request. Do not repeat the same inspection in the parent until the SCOUT RESULT returns.`;
}
