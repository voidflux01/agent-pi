// ABOUTME: Shared task-gate policy used by the runtime and its tests.
// ABOUTME: NORMAL mode is advisory; orchestration modes require an active task.

export const TASK_GATE_BYPASS_TOOLS = [
	"tasks", "set_mode", "dispatch_agent", "dispatch_agents", "ask_user", "run_chain",
	"advance_phase", "pipeline_status",
] as const;

/** Non-read-only workflow tools that require an active task in orchestration modes. */
export const TASK_EXECUTION_TOOLS = ["dispatch_agent", "dispatch_agents", "run_chain", "advance_phase"] as const;

export const READ_ONLY_BYPASS_TOOLS = ["read", "grep", "find", "ls", "glob"] as const;

/** Modes where task tracking is part of the workflow contract. */
export const TASK_REQUIRED_MODES = ["PLAN", "SPEC", "PIPELINE", "TEAM", "CHAIN"] as const;

export function shouldBypassTaskGate(toolName: string, requireActiveTask = false): boolean {
	if (requireActiveTask && (TASK_EXECUTION_TOOLS as readonly string[]).includes(toolName)) return false;
	return (TASK_GATE_BYPASS_TOOLS as readonly string[]).includes(toolName)
		|| toolName.startsWith("commander_")
		|| (READ_ONLY_BYPASS_TOOLS as readonly string[]).includes(toolName);
}

export function taskRequiredForMode(mode: string | undefined): boolean {
	return (TASK_REQUIRED_MODES as readonly string[]).includes(mode ?? "");
}

/** Optional strict lifecycle checks for task lists in NORMAL mode. */
export function taskGateStrict(): boolean {
	return process.env.PI_TASKS_STRICT === "1";
}
