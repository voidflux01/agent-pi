// ABOUTME: Pure per-type dispatch gate — at most one worker of a given agent
// ABOUTME: type may be running; extra dispatches of that type get a pointer back.

export interface TypeWorkerSnapshot {
	id: number;
	name: string;
	status: "running" | "done" | "error";
}

export type TypeDispatchDecision = {
	action: "spawn";
} | {
	action: "blocked-type-running";
	existingId: number;
	message: string;
};

/** Latest matching running worker wins (matches array order = spawn order). */
export function decideTypeDispatch(
	existing: ReadonlyArray<TypeWorkerSnapshot>,
	agentName: string,
): TypeDispatchDecision {
	let match: TypeWorkerSnapshot | undefined;
	for (const worker of existing) {
		if (worker.status === "running" && worker.name.toLowerCase() === agentName.toLowerCase()) {
			match = worker;
		}
	}
	if (!match) return { action: "spawn" };
	return {
		action: "blocked-type-running",
		existingId: match.id,
		message: `Not spawned: SA${match.id} (${match.name}) of the same type is already running. Use subagent_wait [${match.id}] to join it or subagent_continue SA${match.id} for a follow-up; pass force: true to spawn a parallel worker of the same type anyway.`,
	};
}
