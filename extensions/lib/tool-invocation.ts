// ABOUTME: Parameter-aware risk classification for tool invocations.
// ABOUTME: Static tool names are not enough for shell and capability gates;
// ABOUTME: this module proves a narrow read-only subset before allowing it.

import { getCapabilityForTool } from "./capability-registry.ts";
import { RECON_TOOL_NAMES } from "./tool-classification.ts";

const READ_ONLY_BASH_BINS = new Set([
	"date", "uname", "pwd", "whoami", "hostname", "wc", "echo", "printf",
	"true", "false", "basename", "dirname", "nproc", "arch", "id", "printenv",
	"cd", "ls", "find", "grep", "rg", "ffgrep", "head", "tail", "sort", "cut", "tr",
	"cat", "file", "stat", "du", "df", "realpath", "sed", "awk",
]);
const RECON_BASH_BINS = new Set(["find", "grep", "rg", "ffgrep", "ls", "fd", "sed", "head", "tail", "cat", "awk", "sort", "wc", "pwd", "git"]);
const READ_ONLY_GIT_SUBCOMMANDS = new Set(["log", "status", "diff", "show", "branch", "rev-parse", "ls-files", "describe"]);

function bashCommand(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const params = args as Record<string, unknown>;
	for (const key of ["command", "cmd", "script"]) {
		if (typeof params[key] === "string") return params[key].trim();
	}
	return "";
}

function splitShell(command: string): string[] | undefined {
	// Only stderr redirection to a sink or stdout is harmless. All other
	// redirection, expansion, substitution, grouping, and backgrounding fail.
	const normalized = command.replace(/(?:^|\s)2>\s*(?:\/dev\/null|&1)(?=\s|[;|&]|$)/g, " ");
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

function tokenize(segment: string): string[] | undefined {
	const tokens: string[] = [];
	let token = "";
	let quote = "";
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (ch === "\\" && quote !== "'") {
			if (++i >= segment.length) return undefined;
			token += segment[i];
		} else if (ch === "'" || ch === '"') {
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

function readOnlyGit(tokens: string[]): boolean {
	const subcommand = tokens[1] ?? "";
	if (tokens[0] !== "git" || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return false;
	if (subcommand === "status") return tokens.slice(2).every((t) => ["--short", "-s", "--porcelain", "-uno", "--untracked-files=no"].includes(t));
	if (subcommand === "log") return tokens.slice(2).every((t) => t === "--oneline" || /^-(?:[1-9][0-9]*)$/.test(t));
	return !tokens.slice(2).some((t) => /^-(?:C|c|\-\-exec-path)/.test(t));
}

function readOnlySed(tokens: string[]): boolean {
	if (tokens[0] !== "sed") return false;
	let index = tokens[1] === "-n" ? 2 : 1;
	const script = tokens[index++];
	return !!script && /^\d+(?:,\d+)?p$/.test(script) && tokens.slice(index).every((t) => !t.startsWith("-"));
}

function classifyShell(command: string): { readOnly: boolean; recon: boolean } {
	const segments = splitShell(command);
	if (!segments) return { readOnly: false, recon: false };
	let recon = false;
	for (const segment of segments) {
		const tokens = tokenize(segment);
		if (!tokens) return { readOnly: false, recon: false };
		const bin = tokens[0]?.replace(/^\/(?:usr\/)?bin\//, "") ?? "";
		if (bin === "git") {
			if (!readOnlyGit(tokens)) return { readOnly: false, recon: false };
		} else if (bin === "sed") {
			if (!readOnlySed(tokens)) return { readOnly: false, recon: false };
		} else if (!READ_ONLY_BASH_BINS.has(bin)) {
			return { readOnly: false, recon: false };
		}
		if (RECON_BASH_BINS.has(bin)) recon = true;
		if (tokens.some((t) => /^(?:--?(?:exec|execdir|delete|ok)|-delete|-exec|-execdir|-ok)$/.test(t))) return { readOnly: false, recon: false };
	}
	return { readOnly: true, recon };
}

export function classifyToolInvocation(toolName: string, args?: unknown): { readOnly: boolean; recon: boolean; confidence: "explicit" | "parsed" | "unknown" } {
	if (toolName === "bash") {
		const result = classifyShell(bashCommand(args));
		return { ...result, confidence: result.readOnly ? "parsed" : "unknown" };
	}
	if ((RECON_TOOL_NAMES as readonly string[]).includes(toolName)) return { readOnly: true, recon: true, confidence: "explicit" };
	const capability = getCapabilityForTool(toolName);
	if (capability?.risk === "read") return { readOnly: true, recon: false, confidence: "explicit" };
	return { readOnly: false, recon: false, confidence: "unknown" };
}

export function isReadOnlyBash(args?: unknown): boolean {
	return classifyShell(bashCommand(args)).readOnly;
}

export function isReconBash(args?: unknown): boolean {
	const result = classifyShell(bashCommand(args));
	return result.readOnly && result.recon;
}
