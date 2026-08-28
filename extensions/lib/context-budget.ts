// ABOUTME: Pure functions for context window budget monitoring and error detection.
// ABOUTME: Provides budget level thresholds and identifies context-loss API errors.

export type BudgetLevel = "ok" | "warn" | "critical";

export function contextBudgetLevel(pct: number): BudgetLevel {
	if (pct >= 90) return "critical";
	if (pct >= 80) return "warn";
	return "ok";
}

export function isContextLossError(stderr: string): boolean {
	return /unexpected tool_use_id found in tool_result blocks/.test(stderr);
}


export interface SubagentContextBudget {
	/** Maximum agents to start in one batch; zero means defer spawning. */
	maxAgents: number;
	/** Maximum result block sent back into the parent context. */
	resultChars: number;
}

/**
 * Scale background work to the remaining parent context budget. Unknown usage
 * keeps the existing behavior; high usage protects the parent before it
 * reaches the compaction gate.
 */
export function subagentContextBudget(percent: number | undefined, requested: number): SubagentContextBudget {
	const count = Math.max(0, requested);
	if (percent == null || !Number.isFinite(percent)) return { maxAgents: count, resultChars: 3_500 };
	if (percent >= 90) return { maxAgents: 0, resultChars: 1_200 };
	if (percent >= 80) return { maxAgents: Math.min(count, 2), resultChars: 2_000 };
	if (percent >= 70) return { maxAgents: Math.min(count, 3), resultChars: 2_800 };
	return { maxAgents: count, resultChars: 3_500 };
}
