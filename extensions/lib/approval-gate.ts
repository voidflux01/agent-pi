// ABOUTME: PLAN/SPEC implementation gate. Planning files may be written before
// ABOUTME: approval; write/edit/bash outside those trees wait on the viewer.

import { resolve, relative, sep } from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { coordinationState, resetExecutionVerification } from "./coordination-state.ts";
import { isWithinDirectory } from "./path-safety.ts";
import { isScoutRecon, READ_ONLY_BYPASS_TOOLS, TASK_EXECUTION_TOOLS } from "./task-gate.ts";
import { getCapabilityForTool } from "./capability-registry.ts";

export const APPROVAL_REQUIRED_MODES = ["PLAN", "SPEC"] as const;

/** Tools that may run in PLAN/SPEC before the viewer is approved. */
export const APPROVAL_BYPASS_TOOLS = [
	"tasks", "set_mode", "subagent_wait", "ask_user", "show_plan", "show_spec", "show_file", "show_report",
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
	resetExecutionVerification();
}

/** Clear the gate when entering PLAN or SPEC so a prior cycle cannot leak. */
export function resetApprovalForMode(mode: string): void {
	if (mode === "PLAN") {
		coordinationState().planApproved = false;
		coordinationState().planApprovalBinding = undefined;
		resetExecutionVerification();
	}
	if (mode === "SPEC") {
		coordinationState().specApproved = false;
		coordinationState().specApprovalBinding = undefined;
		resetExecutionVerification();
	}
}

export function markPlanApproved(filePath?: string, content?: string): void {
	const state = coordinationState();
	state.planApproved = true;
	if (!filePath) {
		state.planApprovalBinding = undefined;
		return;
	}
	const absolute = resolve(filePath);
	state.planApprovalBinding = content != null
		? {
			filePath: absolute,
			contentFingerprint: fingerprintContent(content),
			fileFingerprint: fingerprintContent(`${absolute}\0${Buffer.from(content, "utf8").toString("base64")}`),
		}
		: { filePath: absolute, ...fingerprintFile(filePath) };
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

const READ_ONLY_BASH_BINS = new Set([
	"date", "uname", "pwd", "whoami", "hostname", "wc", "echo", "printf",
	"true", "false", "basename", "dirname", "nproc", "arch", "id", "printenv",
	"cd", "ls", "find", "grep", "rg", "ffgrep", "head", "tail", "sort", "cut", "tr",
	"cat", "file", "stat", "du", "df", "realpath", "sed",
]);

// Keep Git support deliberately narrow. `git` has many commands that can
// mutate the repository (and even some read-looking commands accept config
// or hook-related options), so the binary itself must not be treated as a
// blanket read-only command.
const READ_ONLY_GIT_SUBCOMMANDS = new Set(["log", "status"]);

function isReadOnlyGit(tokens: string[]): boolean {
	if (tokens[0] !== "git" || !READ_ONLY_GIT_SUBCOMMANDS.has(tokens[1] ?? "")) return false;
	const subcommand = tokens[1];
	const args = tokens.slice(2);
	if (subcommand === "status") {
		return args.every((token) => ["--short", "-s", "--porcelain", "-uno", "--untracked-files=no"].includes(token));
	}
	// Keep log options to presentation/count controls. In particular, do not
	// allow Git global options such as -c/-C or arbitrary revisions here.
	return args.every((token) => token === "--oneline" || /^-(?:[1-9][0-9]*)$/.test(token));
}

function bashCommand(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const params = args as Record<string, unknown>;
	for (const key of ["command", "cmd", "script"]) {
		if (typeof params[key] === "string") return params[key].trim();
	}
	return "";
}

/**
 * Split a small, deliberately conservative shell subset. Quotes are retained
 * in segments so grep/find patterns such as "foo bar" remain valid. Shell
 * expansion, redirection, backgrounding, and command substitution are not
 * accepted; the one harmless exception is stderr suppression to /dev/null.
 */
function readOnlyBashSegments(command: string): string[] | undefined {
	const normalized = command.replace(/(?:^|\s)2>\s*\/dev\/null(?=\s|[;|&]|$)/g, " ");
	const segments: string[] = [];
	let start = 0;
	let quote = "";
	for (let i = 0; i < normalized.length; i++) {
		const ch = normalized[i];
		if (ch === "\\" && quote !== "'") { i++; continue; }
		if (ch === "'" || ch === '"') {
			if (!quote) quote = ch;
			else if (quote === ch) quote = "";
			continue;
		}
		if (quote) continue;
		if (ch === "$" || ch === "`" || ch === "<" || ch === ">" || ch === "(" || ch === ")" || ch === "{" || ch === "}" || ch === "!") return undefined;
		if (ch === ";" || ch === "\n" || ch === "|") {
			if (ch === "|" && normalized[i + 1] === "|") i++;
			const segment = normalized.slice(start, i).trim();
			if (!segment) return undefined;
			segments.push(segment);
			start = i + 1;
		} else if (ch === "&") {
			if (normalized[i + 1] !== "&") return undefined;
			const segment = normalized.slice(start, i).trim();
			if (!segment) return undefined;
			segments.push(segment);
			i++;
			start = i + 1;
		}
	}
	if (quote) return undefined;
	const last = normalized.slice(start).trim();
	if (!last) return undefined;
	segments.push(last);
	return segments;
}

function readOnlyBashTokens(segment: string): string[] | undefined {
	const tokens: string[] = [];
	let token = "";
	let quote = "";
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (ch === "\\" && quote !== "'") {
			if (++i >= segment.length) return undefined;
			token += segment[i];
		} else if ((ch === "'" || ch === '"')) {
			if (!quote) quote = ch;
			else if (quote === ch) quote = "";
			else token += ch;
		} else if (!quote && /\s/.test(ch)) {
			if (token) { tokens.push(token); token = ""; }
		} else token += ch;
	}
	if (quote) return undefined;
	if (token) tokens.push(token);
	return tokens.length ? tokens : undefined;
}

/** Allow only sed's non-mutating line-printing form. */
function isReadOnlySed(tokens: string[]): boolean {
	if (tokens[0] !== "sed") return false;
	let index = 1;
	if (tokens[index] === "-n") index++;
	if (index >= tokens.length) return false;
	const script = tokens[index++];
	if (!/^\d+(?:,\d+)?p$/.test(script)) return false;
	return tokens.slice(index).every((token) => !token.startsWith("-"));
}

/** True for inspection-only bash, including safe composed read-only commands. */
export function isReadOnlyBash(args: unknown): boolean {
	const command = bashCommand(args);
	if (!command) return false;
	const segments = readOnlyBashSegments(command);
	if (!segments) return false;
	return segments.every((segment) => {
		const tokens = readOnlyBashTokens(segment);
		if (!tokens) return false;
		const bin = tokens[0]?.replace(/^\/(?:usr\/)?bin\//, "") ?? "";
		if (bin === "git") return isReadOnlyGit(tokens);
		if (bin === "sed") return isReadOnlySed(tokens);
		if (!READ_ONLY_BASH_BINS.has(bin)) return false;
		return !tokens.some((token) => /^(?:--?(?:exec|execdir|delete|ok)|-delete|-exec|-execdir|-ok)$/.test(token));
	});
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
	if (toolName === "bash" && isReadOnlyBash(args)) return { block: false };
	if ((FILE_MUTATION_TOOLS as readonly string[]).includes(toolName)) {
		const path = toolPath(args);
		if (path && isPlanningArtifact(mode, path, cwd)) return { block: false };
	}
	const discovered = getCapabilityForTool(toolName);
	if (discovered && discovered.risk !== "read") {
		const reason = mode === "PLAN"
			? "PLAN implementation is blocked until show_plan is approved. The discovered tool is not read-only."
			: "SPEC implementation is blocked until show_spec is approved. The discovered tool is not read-only.";
		return { block: true, reason };
	}

	if (!(IMPLEMENTATION_TOOLS as readonly string[]).includes(toolName)) return { block: false };

	const reason = mode === "PLAN"
		? "PLAN implementation is blocked until show_plan is approved. Write .context/todo.md and call show_plan. Read-only tools, tasks, ask_user, and scout may proceed."
		: "SPEC implementation is blocked until show_spec is approved. Write under context-os/ and call show_spec. Read-only tools, tasks, ask_user, and show_plan (questions) may proceed.";
	return { block: true, reason };
}
