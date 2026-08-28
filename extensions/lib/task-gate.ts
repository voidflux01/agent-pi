// ABOUTME: Shared task-gate policy used by the runtime and its tests.
// ABOUTME: NORMAL lists are strict by default; set PI_TASKS_STRICT=0 for advisory.

export const TASK_GATE_BYPASS_TOOLS = [
	"tasks", "set_mode", "dispatch_agent", "dispatch_agents", "ask_user", "run_chain",
	"advance_phase", "pipeline_status",
] as const;

/** Non-read-only workflow tools that require an active task in orchestration modes. */
export const TASK_EXECUTION_TOOLS = ["dispatch_agent", "dispatch_agents", "run_chain", "advance_phase"] as const;

export const READ_ONLY_BYPASS_TOOLS = ["read", "grep", "find", "ls", "glob"] as const;

/** Modes where task tracking is part of the workflow contract. */
export const TASK_REQUIRED_MODES = ["PLAN", "SPEC", "PIPELINE", "TEAM", "CHAIN"] as const;

function toolArgs(args: unknown): Record<string, unknown> {
	return args && typeof args === "object" ? args as Record<string, unknown> : {};
}

export function isScoutName(value: unknown): boolean {
	return String(value ?? "").trim().toLowerCase() === "scout";
}

/** Scout `subagent_create` blocks the parent until RESULT; other roles stay background. */
export function shouldAwaitSubagentResult(name: unknown): boolean {
	return isScoutName(name);
}

/** True for read-only scout reconnaissance that must not wait on a task list. */
export function isScoutRecon(toolName: string, args?: unknown): boolean {
	const params = toolArgs(args);
	if (toolName === "subagent_create") return isScoutName(params.name);
	if (toolName === "subagent_create_batch") {
		const agents = Array.isArray(params.agents) ? params.agents : [];
		return agents.length > 0 && agents.every((agent) => isScoutName((agent as { name?: unknown })?.name));
	}
	return false;
}

export function shouldBypassTaskGate(toolName: string, requireActiveTask = false, args?: unknown): boolean {
	if (isScoutRecon(toolName, args)) return true;
	if (requireActiveTask && (TASK_EXECUTION_TOOLS as readonly string[]).includes(toolName)) return false;
	return (TASK_GATE_BYPASS_TOOLS as readonly string[]).includes(toolName)
		|| toolName.startsWith("commander_")
		|| (READ_ONLY_BYPASS_TOOLS as readonly string[]).includes(toolName);
}

export function taskRequiredForMode(mode: string | undefined): boolean {
	return (TASK_REQUIRED_MODES as readonly string[]).includes(mode ?? "");
}

/** Strict lifecycle checks for existing NORMAL task lists. Opt out with PI_TASKS_STRICT=0. */
export function taskGateStrict(): boolean {
	return process.env.PI_TASKS_STRICT !== "0";
}
