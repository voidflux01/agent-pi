// ABOUTME: Shared task-gate policy used by the runtime and its tests.
// ABOUTME: NORMAL lists are strict by default; set PI_TASKS_STRICT=0 for advisory.

import { isToolkitCliAgent } from "./toolkit-cli.ts";
import { RECON_TOOL_NAMES } from "./tool-classification.ts";
import { classifyToolInvocation, isReadOnlyBash } from "./tool-invocation.ts";

export const TASK_GATE_BYPASS_TOOLS = [
	"tasks", "set_mode", "team_batch_recover", "subagent_wait", "ask_user", "verify_execution", "verifier_override", "show_report",
	"pipeline_status",
] as const;

/** Non-read-only workflow tools that require an active task in every mode —
 *  the declaration duty applies to delegation the same as direct bash. */
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

export { isReadOnlyBash } from "./tool-invocation.ts";

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
	if (classifyToolInvocation(toolName, args).readOnly) return true;
	if ((TASK_EXECUTION_TOOLS as readonly string[]).includes(toolName)) return false;
	return (TASK_GATE_BYPASS_TOOLS as readonly string[]).includes(toolName)
		|| (READ_ONLY_BYPASS_TOOLS as readonly string[]).includes(toolName);
}

export function taskRequiredForMode(mode: string | undefined): boolean {
	return (TASK_REQUIRED_MODES as readonly string[]).includes(mode ?? "");
}

/**
 * Whether the task gate must demand an active (inprogress) task in the current
 * mode. Orchestration modes require it, EXCEPT PLAN/SPEC before the plan/spec
 * is approved: task creation is blocked until approval (see
 * decidePreApprovalTaskCreationGate) and the approval gate (mode-cycler)
 * already blocks implementation with a precise "approve first" reason. An
 * active-task demand here emits the impossible instruction "create a task"
 * (itself blocked pre-approval), which made agents drop to NORMAL to seed a
 * placeholder task — breaking the single-pass PLAN flow (write plan → show_plan
 * → approve → rebuild tasks → execute). Pre-approval, the approval gate owns
 * the phase; the task gate starts binding once approval unlocks implementation.
 */
export function taskGateRequiresActiveTask(mode: string | undefined, approved: boolean): boolean {
	if (!taskRequiredForMode(mode)) return false;
	if ((mode === "PLAN" || mode === "SPEC") && !approved) return false;
	return true;
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

/**
 * Task actions that create or activate the working list. In PLAN/SPEC these
 * must wait until the plan/spec is approved, so an agent cannot seed a coarse
 * placeholder task before the approved plan/spec exists (the sequencing bug
 * that collapsed multi-step plans into one coarse task). Read-only management
 * (list/update/remove) stays available pre-approval.
 */
export const TASK_CREATION_ACTIONS = ["new-list", "add", "toggle"] as const;

export function isTaskCreationAction(action: unknown): boolean {
	return (TASK_CREATION_ACTIONS as readonly string[]).includes(String(action ?? ""));
}

/**
 * Gate decision: in PLAN/SPEC, creating/activating the task list before the
 * plan/spec is approved is blocked. `approved` is the approval state for the
 * current mode. Other modes (or post-approval) never block here.
 */
export function decidePreApprovalTaskCreationGate(input: {
	mode: string | undefined;
	approved: boolean;
	action: unknown;
}): { block: boolean; reason?: string } {
	if (input.mode !== "PLAN" && input.mode !== "SPEC") return { block: false };
	if (input.approved) return { block: false };
	if (!isTaskCreationAction(input.action)) return { block: false };
	const planLabel = input.mode === "PLAN" ? "plan" : "spec";
	const approveTool = input.mode === "PLAN" ? "show_plan" : "show_spec";
	const planPath = input.mode === "PLAN" ? ".context/todo.md" : "spec folder documents";
	return {
		block: true,
		reason: `The ${input.mode} ${planLabel} is not approved yet, so tasks cannot be created or activated. Write the ${planLabel} (${planPath}) and call ${approveTool} first. After approval, rebuild the task list from the approved ${planLabel} (tasks new-list + add for each concrete step).`,
	};
}
