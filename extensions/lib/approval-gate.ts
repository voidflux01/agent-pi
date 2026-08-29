// ABOUTME: PLAN/SPEC implementation gate. Planning files may be written before
// ABOUTME: approval; write/edit/bash outside those trees wait on the viewer.

import { resolve } from "node:path";
import { coordinationState } from "./coordination-state.ts";
import { isWithinDirectory } from "./path-safety.ts";
import { isScoutRecon, READ_ONLY_BYPASS_TOOLS, TASK_EXECUTION_TOOLS } from "./task-gate.ts";

export const APPROVAL_REQUIRED_MODES = ["PLAN", "SPEC"] as const;

/** Tools that may run in PLAN/SPEC before the viewer is approved. */
export const APPROVAL_BYPASS_TOOLS = [
	"tasks", "set_mode", "ask_user", "show_plan", "show_spec", "show_file", "show_report",
	"pipeline_status",
] as const;

export const FILE_MUTATION_TOOLS = ["write", "edit", "write_file", "edit_file"] as const;

export const IMPLEMENTATION_TOOLS = [
	...FILE_MUTATION_TOOLS,
	"bash",
	...TASK_EXECUTION_TOOLS,
	"subagent_create",
	"subagent_create_batch",
] as const;

export function resetApprovals(): void {
	const state = coordinationState();
	state.planApproved = false;
	state.specApproved = false;
}

/** Clear the gate when entering PLAN or SPEC so a prior cycle cannot leak. */
export function resetApprovalForMode(mode: string): void {
	if (mode === "PLAN") coordinationState().planApproved = false;
	if (mode === "SPEC") coordinationState().specApproved = false;
}

export function markPlanApproved(): void {
	coordinationState().planApproved = true;
}

export function markSpecApproved(): void {
	coordinationState().specApproved = true;
}

export function isPlanApproved(): boolean {
	return coordinationState().planApproved;
}

export function isSpecApproved(): boolean {
	return coordinationState().specApproved;
}

export function approvalStateForMode(mode: string | undefined): boolean {
	if (mode === "PLAN") return coordinationState().planApproved;
	if (mode === "SPEC") return coordinationState().specApproved;
	return true;
}

export function isApprovalGatedMode(mode: string | undefined): mode is "PLAN" | "SPEC" {
	return mode === "PLAN" || mode === "SPEC";
}

function planningRootName(mode: string): ".context" | "context-os" | undefined {
	if (mode === "PLAN") return ".context";
	if (mode === "SPEC") return "context-os";
	return undefined;
}

/** True when the path is a descendant of `<cwd>/.context` (PLAN) or `<cwd>/context-os` (SPEC). */
export function isPlanningArtifact(mode: string, filePath: string, cwd?: string): boolean {
	const rootName = planningRootName(mode);
	if (!rootName || !filePath.trim()) return false;
	const raw = filePath.trim();
	if (cwd && cwd.trim()) {
		const base = resolve(cwd);
		return isWithinDirectory(resolve(base, rootName), resolve(base, raw));
	}
	const posix = raw.replace(/\\/g, "/");
	if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) return false;
	const parts = posix.split("/").filter(Boolean);
	if (parts.includes("..") || parts.includes("")) return false;
	return parts[0] === rootName;
}

function nestedCallTool(args: unknown): { toolName: string; args: unknown } | undefined {
	if (!args || typeof args !== "object") return undefined;
	const params = args as Record<string, unknown>;
	const toolName = typeof params.tool_name === "string"
		? params.tool_name
		: typeof params.name === "string" ? params.name : "";
	if (!toolName.trim()) return undefined;
	return { toolName: toolName.trim(), args: params.arguments ?? params.args ?? params.input ?? {} };
}

export function toolPath(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const params = args as Record<string, unknown>;
	for (const key of ["path", "file", "file_path"]) {
		if (typeof params[key] === "string" && params[key].trim()) return params[key].trim();
	}
	return undefined;
}

export function decideApprovalGate(input: {
	mode: string | undefined;
	approved: boolean;
	toolName: string;
	args?: unknown;
	cwd?: string;
}): { block: boolean; reason?: string } {
	const { mode, approved, toolName, args, cwd } = input;
	if (!isApprovalGatedMode(mode) || approved) return { block: false };
	if (toolName === "call_tool") {
		const nested = nestedCallTool(args);
		if (!nested) {
			return { block: true, reason: "call_tool in PLAN/SPEC requires tool_name. Implementation tools stay blocked until approval." };
		}
		if (nested.toolName === "call_tool" || nested.toolName === "tool_search") {
			return { block: true, reason: "call_tool cannot proxy call_tool or tool_search." };
		}
		return decideApprovalGate({ ...input, toolName: nested.toolName, args: nested.args });
	}
	if (isScoutRecon(toolName, args)) return { block: false };
	if ((APPROVAL_BYPASS_TOOLS as readonly string[]).includes(toolName)) return { block: false };
	if ((READ_ONLY_BYPASS_TOOLS as readonly string[]).includes(toolName)) return { block: false };
	if (toolName.startsWith("commander_")) return { block: false };

	if ((FILE_MUTATION_TOOLS as readonly string[]).includes(toolName)) {
		const path = toolPath(args);
		if (path && isPlanningArtifact(mode, path, cwd)) return { block: false };
	}

	if (!(IMPLEMENTATION_TOOLS as readonly string[]).includes(toolName)) return { block: false };

	const reason = mode === "PLAN"
		? "PLAN implementation is blocked until show_plan is approved. Write .context/todo.md and call show_plan. Read-only tools, tasks, ask_user, and scout may proceed."
		: "SPEC implementation is blocked until show_spec is approved. Write under context-os/ and call show_spec. Read-only tools, tasks, ask_user, and show_plan (questions) may proceed.";
	return { block: true, reason };
}
