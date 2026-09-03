// ABOUTME: Shared task-gate policy used by the runtime and its tests.
// ABOUTME: NORMAL lists are strict by default; set PI_TASKS_STRICT=0 for advisory.

import { isToolkitCliAgent } from "./toolkit-cli.ts";
import { RECON_TOOL_NAMES } from "./tool-classification.ts";

export const TASK_GATE_BYPASS_TOOLS = [
	"tasks", "set_mode", "subagent_create", "subagent_create_batch", "team_batch_recover", "subagent_wait", "ask_user", "verify_execution", "show_report",
	"advance_phase", "pipeline_status",
] as const;

/** Non-read-only workflow tools that require an active task in orchestration modes. */
export const TASK_EXECUTION_TOOLS = ["subagent_create", "subagent_create_batch", "advance_phase", "compose_exec"] as const;

export const READ_ONLY_BYPASS_TOOLS = RECON_TOOL_NAMES;

/** Modes where task tracking is part of the workflow contract. */
export const TASK_REQUIRED_MODES = ["PLAN", "SPEC", "PIPELINE", "TEAM", "CHAIN"] as const;

const PLANNING_FILE_TOOLS = ["write", "edit", "write_file", "edit_file"] as const;

function toolArgs(args: unknown): Record<string, unknown> {
	return args && typeof args === "object" ? args as Record<string, unknown> : {};
}

function taskGatePath(args: unknown): string {
	const params = toolArgs(args);
	for (const key of ["path", "file", "file_path"]) {
		if (typeof params[key] === "string") return params[key].trim().replace(/\\/g, "/");
	}
	return "";
}

/** Planning documents are the only writes allowed before a viewer approval. */
export function isPlanningArtifactWrite(toolName: string, mode: string | undefined, args?: unknown): boolean {
	if (!(PLANNING_FILE_TOOLS as readonly string[]).includes(toolName)) return false;
	const path = taskGatePath(args);
	if (mode === "PLAN") return path === ".context/todo.md";
	if (mode === "SPEC") return path === "context-os" || path.startsWith("context-os/");
	return false;
}

export function isScoutName(value: unknown): boolean {
	return String(value ?? "").trim().toLowerCase() === "scout";
}

export function isResearcherName(value: unknown): boolean {
	return String(value ?? "").trim().toLowerCase() === "researcher";
}

/** Scout and toolkit CLIs block until they finish; other roles stay background. */
export function shouldAwaitSubagentResult(name: unknown): boolean {
	if (isScoutName(name) || isResearcherName(name)) return true;
	return isToolkitCliAgent(String(name ?? ""));
}

/** True for read-only scout reconnaissance that must not wait on a task list. */
export function isScoutRecon(toolName: string, args?: unknown): boolean {
	const params = toolArgs(args);
	if (toolName === "subagent_create") return isScoutName(params.name) || isResearcherName(params.name);
	if (toolName === "subagent_create_batch") {
		const agents = Array.isArray(params.agents) ? params.agents : [];
		return agents.length > 0 && agents.every((agent) => {
			const name = (agent as { name?: unknown })?.name;
			return isScoutName(name) || isResearcherName(name);
		});
	}
	return false;
}

export function shouldBypassTaskGate(toolName: string, requireActiveTask = false, args?: unknown): boolean {
	if (isScoutRecon(toolName, args)) return true;
	if (requireActiveTask && (TASK_EXECUTION_TOOLS as readonly string[]).includes(toolName)) return false;
	return (TASK_GATE_BYPASS_TOOLS as readonly string[]).includes(toolName)
		|| (READ_ONLY_BYPASS_TOOLS as readonly string[]).includes(toolName);
}

export function taskRequiredForMode(mode: string | undefined): boolean {
	return (TASK_REQUIRED_MODES as readonly string[]).includes(mode ?? "");
}

/** Start a follow-up turn for leftover tasks. TEAM/CHAIN/PIPELINE coordinators
 *  often stop with the last task still inprogress; forcing a new turn aborts
 *  the session. Display the list, but do not triggerTurn in that case. */
export function taskValidationTriggerTurn(
	mode: string | undefined,
	incomplete: ReadonlyArray<{ status: string }>,
): boolean {
	if (mode !== "TEAM" && mode !== "CHAIN" && mode !== "PIPELINE") return true;
	const hasIdle = incomplete.some((t) => t.status === "idle");
	const hasInprogress = incomplete.some((t) => t.status === "inprogress");
	if (hasInprogress && !hasIdle) return false;
	return true;
}

/** Strict lifecycle checks for existing NORMAL task lists. Opt out with PI_TASKS_STRICT=0. */
export function taskGateStrict(): boolean {
	return process.env.PI_TASKS_STRICT !== "0";
}
