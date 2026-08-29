// ABOUTME: PLAN/SPEC implementation gate. Planning files may be written before
// ABOUTME: approval; write/edit/bash outside those trees wait on the viewer.

import { resolve, relative, sep } from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
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

export function fingerprintContent(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Fingerprint a file's path and bytes. Missing files have a stable sentinel. */
export function fingerprintFile(filePath: string): { fileFingerprint: string; contentFingerprint: string } {
	const absolute = resolve(filePath);
	try {
		const content = readFileSync(absolute);
		return { contentFingerprint: fingerprintContent(content.toString("utf8")), fileFingerprint: fingerprintContent(`${absolute}\0${content.toString("base64")}`) };
	} catch {
		return { contentFingerprint: fingerprintContent("<missing>"), fileFingerprint: fingerprintContent(`${absolute}\0<missing>`) };
	}
}

/** Fingerprint all files in a spec folder, including relative names and contents. */
export function fingerprintDirectory(folderPath: string): { fileFingerprint: string; contentFingerprint: string } {
	const root = resolve(folderPath);
	const entries: Array<[string, string]> = [];
	const walk = (dir: string) => {
		let names: string[]; try { names = readdirSync(dir); } catch { return; }
		for (const name of names.sort()) {
			const path = resolve(dir, name); let st; try { st = statSync(path); } catch { continue; }
			if (st.isDirectory()) walk(path);
			else if (st.isFile()) { try { entries.push([relative(root, path).split(sep).join("/"), readFileSync(path).toString("base64")]); } catch {} }
		}
	};
	walk(root);
	const serialized = JSON.stringify(entries);
	return { contentFingerprint: fingerprintContent(serialized), fileFingerprint: fingerprintContent(`${root}\0${serialized}`) };
}

export function resetApprovals(): void {
	const state = coordinationState();
	state.planApproved = false;
	state.specApproved = false;
	state.planApprovalBinding = undefined;
	state.specApprovalBinding = undefined;
}

/** Clear the gate when entering PLAN or SPEC so a prior cycle cannot leak. */
export function resetApprovalForMode(mode: string): void {
	if (mode === "PLAN") { coordinationState().planApproved = false; coordinationState().planApprovalBinding = undefined; }
	if (mode === "SPEC") { coordinationState().specApproved = false; coordinationState().specApprovalBinding = undefined; }
}

export function markPlanApproved(filePath?: string): void {
	const state = coordinationState(); state.planApproved = true;
	state.planApprovalBinding = filePath ? { filePath: resolve(filePath), ...fingerprintFile(filePath) } : undefined;
}

export function markSpecApproved(folderPath?: string): void {
	const state = coordinationState(); state.specApproved = true;
	state.specApprovalBinding = folderPath ? { folderPath: resolve(folderPath), ...fingerprintDirectory(folderPath) } : undefined;
}

export function isPlanApproved(): boolean { return approvalStateForMode("PLAN"); }
export function isSpecApproved(): boolean { return approvalStateForMode("SPEC"); }

function bindingStillMatches(mode: "PLAN" | "SPEC"): boolean {
	const state = coordinationState();
	if (mode === "PLAN") {
		const b = state.planApprovalBinding; if (!b) return state.planApproved;
		const now = fingerprintFile(b.filePath); return now.fileFingerprint === b.fileFingerprint && now.contentFingerprint === b.contentFingerprint;
	}
	const b = state.specApprovalBinding; if (!b) return state.specApproved;
	const now = fingerprintDirectory(b.folderPath); return now.fileFingerprint === b.fileFingerprint && now.contentFingerprint === b.contentFingerprint;
}

export function approvalStateForMode(mode: string | undefined): boolean {
	if (mode === "PLAN") return coordinationState().planApproved && bindingStillMatches("PLAN");
	if (mode === "SPEC") return coordinationState().specApproved && bindingStillMatches("SPEC");
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
	const { mode, toolName, args, cwd } = input;
	let approved = input.approved;
	// Never trust a stale caller-supplied boolean once an approval is bound.
	if (mode === "PLAN" && coordinationState().planApprovalBinding) approved = approved && bindingStillMatches("PLAN");
	if (mode === "SPEC" && coordinationState().specApprovalBinding) approved = approved && bindingStillMatches("SPEC");
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
