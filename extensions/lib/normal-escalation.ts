// ABOUTME: Runtime guard that nudges NORMAL out of unbounded read-only exploration.
// ABOUTME: Keeps simple work frictionless while requiring a low-cost scout after a recon loop.

export const NORMAL_RECON_TOOLS = ["read", "grep", "find", "ls", "glob"] as const;
export const NORMAL_RECON_LIMIT = 8;

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
	return (NORMAL_RECON_TOOLS as readonly string[]).includes(toolName);
}

/** Conservative classification for shell-based repository reconnaissance. */
export function isNormalReconCall(toolName: string, args?: unknown): boolean {
	if (isNormalReconTool(toolName)) return true;
	if (toolName !== "bash") return false;
	const params = args && typeof args === "object" ? args as Record<string, unknown> : {};
	const command = typeof params.command === "string"
		? params.command
		: typeof params.cmd === "string" ? params.cmd : "";
	if (!command.trim()) return false;
	// A command containing mutation, installation, or test execution is a
	// boundary between reconnaissance loops and real work.
	if (/(^|\s)(rm|mv|cp|mkdir|touch|tee)\b|sed\s+-i\b|perl\s+-i\b|git\s+(add|commit|reset|checkout|switch|clean)\b|\b(npm|bun|pnpm|yarn)\s+(install|test|run)\b|(?:>>|>)/i.test(command)) {
		return false;
	}
	return /(^|\s)(rg|grep|find|ls|fd|sed|head|tail|cat|awk|sort|wc|pwd|git)\b/i.test(command);
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
