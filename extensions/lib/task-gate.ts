// ABOUTME: Shared task-gate policy used by the runtime and its tests.
// ABOUTME: NORMAL mode is advisory by default; strict blocking is an explicit opt-in.

export const TASK_GATE_BYPASS_TOOLS = [
	"tasks", "dispatch_agent", "dispatch_agents", "ask_user", "run_chain",
	"advance_phase", "pipeline_status",
] as const;

export const READ_ONLY_BYPASS_TOOLS = ["read", "grep", "find", "ls", "glob"] as const;

export function shouldBypassTaskGate(toolName: string): boolean {
	return (TASK_GATE_BYPASS_TOOLS as readonly string[]).includes(toolName)
		|| toolName.startsWith("commander_")
		|| (READ_ONLY_BYPASS_TOOLS as readonly string[]).includes(toolName);
}

export function taskGateStrict(): boolean {
	return process.env.PI_TASKS_STRICT === "1";
}
