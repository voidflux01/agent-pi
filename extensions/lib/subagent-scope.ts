// ABOUTME: Pure same-scope dispatch decision shared by subagent tooling and tests.
// ABOUTME: Dedup keys are caller-declared scope strings — never task-text heuristics.

export interface ScopeWorkerSnapshot {
	id: number;
	name: string;
	scope?: string;
	status: "running" | "done" | "error";
	resultStatus?: "PASS" | "FAIL" | "BLOCKED";
}

export type ScopeDispatchDecision = {
	action: "spawn";
	priorNote: string;
} | {
	action: "blocked-running";
	existingId: number;
	message: string;
} | {
	action: "blocked-pass";
	existingId: number;
	message: string;
};

/** Latest matching worker wins (matches array order = spawn order). */
export function decideScopeDispatch(
	existing: ReadonlyArray<ScopeWorkerSnapshot>,
	agentName: string,
	scope: string,
): ScopeDispatchDecision {
	const normalizedScope = scope.trim();
	if (!normalizedScope) return { action: "spawn", priorNote: "" };
	let match: ScopeWorkerSnapshot | undefined;
	for (const worker of existing) {
		if (worker.scope?.trim() === normalizedScope && worker.name.toLowerCase() === agentName.toLowerCase()) {
			match = worker;
		}
	}
	if (!match) return { action: "spawn", priorNote: "" };
	if (match.status === "running") {
		return {
			action: "blocked-running",
			existingId: match.id,
			message: `Not spawned: SA${match.id} (${match.name}, scope "${normalizedScope}") is already running. Use subagent_wait [${match.id}] to join it or subagent_continue SA${match.id} for a follow-up; pass force: true to spawn a parallel worker anyway.`,
		};
	}
	if (match.resultStatus === "PASS") {
		return {
			action: "blocked-pass",
			existingId: match.id,
			message: `Not spawned: SA${match.id} (${match.name}, scope "${normalizedScope}") already completed this scope with status PASS — its RESULT is in your context. Pass force: true to run it again anyway.`,
		};
	}
	return {
		action: "spawn",
		priorNote: `Prior round for scope "${normalizedScope}": SA${match.id} (${match.name}) concluded ${match.resultStatus ?? "without a valid RESULT"} — narrow this round's audit to its findings instead of re-auditing everything.`,
	};
}
