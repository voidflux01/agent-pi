// ABOUTME: Precision-preserving sub-agent result contract.
// ABOUTME: Sub-agents end their final message with a ## RESULT block; the
// ABOUTME: orchestrator extracts that block for the parent context while the
// ABOUTME: FULL transcript is always persisted to disk and pointed to, so
// ABOUTME: token savings never silently drop information.
// ABOUTME: Shared by agent-team.ts, agent-chain.ts, and pipeline-team.ts.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatDuration } from "./duration-format.ts";

export const RESULT_MARKER = "## RESULT";
export const RESULT_END_MARKER = "## END";

/** Preserve the complete worker report when passing it to the parent/next step. */
export function boundedHandoff(text: string, _maxChars?: number): string {
	return String(text || "");
}

/**
 * Build the next-step handoff without replaying an unstructured transcript.
 * Empty or unrecoverable output still has a complete archive for recovery,
 * but noisy fallback (tool help, repeated logs, and raw diffs) must not become
 * instructions for the next worker.
 */
export function compactHandoff(opts: {
	agent: string;
	status: "done" | "error";
	elapsedMs: number;
	model?: string;
	composed: ComposedAgentResult;
	fullOutputPath: string;
}): string {
	if (opts.composed.usedResult) return opts.composed.content;
	const header = `[${opts.agent}] ${opts.status} in ${formatDuration(opts.elapsedMs)}${opts.model ? ` (${opts.model})` : ""}`;
	const archive = opts.fullOutputPath ? `\nFull transcript: ${opts.fullOutputPath}` : "";
	return `${header}\n\nRESULT contract missing; do not infer completion from this worker. Read the archived transcript only if the next decision requires it.${archive}`;
}

/** Preserve the complete worker report in structured details and UI previews. */
export function boundedOutputPreview(text: string, _maxChars?: number): string {
	return String(text || "");
}

/** Build the one-shot user message used on a worker's first turn. */
export function buildWorkerInitialPrompt(opts: {
	role?: string;
	task: string;
	rolePrompt?: string;
	additionalInstructions?: string;
}): string {
	const role = opts.role ? `You are the ${opts.role} worker.` : "You are a delegated worker.";
	const resultRole = opts.role?.trim() || "worker";
	return [
		role,
		stripEmbeddedResultProtocol(opts.rolePrompt),
		"Execute only the supplied task and scope. Treat its objective, acceptance criteria, evidence requirements, and constraints as the contract; do not ask the coordinator to repeat work you can finish.",
		"Inspect the baseline before edits, use real commands, preserve tests/checks, and never fake green with skips, weaker assertions, deleted checks, changed thresholds, a fake subject, or `|| true`. Keep active plan/spec state current and report blockers in RESULT; do not invent tracking files, and stop after repeated failure, worse results, or satisfied scope.",
		"",
		"Task:",
		stripTaskResultWrapper(opts.task),
		"",
		opts.additionalInstructions?.trim(),
		"",
		"Before stopping, emit exactly one plain-text RESULT block at the end; put evidence and file:line references under findings. If you already wrote a prose report, keep it inside findings and still emit the block. Do not emit another result block or prose after END.",
		"## RESULT",
		`role: ${resultRole}`,
		"done: true|false",
		"status: PASS|FAIL|BLOCKED",
		...(role.trim().toLowerCase() === "reviewer"
			? [
				"decision: APPROVED|NEEDS CHANGES",
				"summary: one or two lines describing the outcome",
				"(decision line above MUST be exactly APPROVED or NEEDS CHANGES — the parent gate matches that literal word and treats narrative verdicts as UNKNOWN, blocking the result from handoff.)",
			]
			: ["summary: one or two lines describing the outcome"]),
		"findings:",
		"- detailed findings, evidence, and relevant code snippets",
		"external_research_needed: true|false",
		"queries: omit when false; focused questions when true",
		"reason: omit when false; blocking external fact when true",
		"files: none or every created/modified path",
		"key_errors: none or exact errors and resolutions",
		"verification: exact commands/tests and their outcome, or not run",
		"remaining: none or unresolved items",
		"## END",
		"Do not put prose after ## END. done means whether this run reached a result; status carries the outcome. A completed audit may use done: true with status: BLOCKED. If the run was interrupted before reaching a result, use done: false and record the exact blocker under key_errors and remaining.",
	].filter((part) => part !== undefined && part !== "").join("\n");
}

/** Remove legacy result-wrapper instructions from role text before composition. */
function stripEmbeddedResultProtocol(prompt?: string): string | undefined {
	if (!prompt?.trim()) return undefined;
	let value = prompt.trim();
	// Agent definition files may still contain a legacy reporting protocol.
	// The runtime owns that protocol now, so remove the whole protocol-bearing
	// tail rather than trying to repair individual lines from it.
	value = value.replace(/^\s*- If external information is required[\s\S]*?(?=^\s*- The final assistant message MUST end)/im, "");
	value = value.replace(/^\s*- The final assistant message MUST end[\s\S]*$/im, "");
	value = value.replace(/^\s*## Output Format\s*$[\s\S]*$/im, "");
	// Runtime owns generic safety and reporting protocol; keep role prompts focused
	// on role-specific judgment instead of repeating shared boilerplate.
	value = value.replace(/^\s*## Security Redlines\s*$[\s\S]*?(?=^##\s|\s*$)/gim, "");
	value = value.replace(/^\s*## Result Contract\s*$[\s\S]*?(?=^##\s|\s*$)/gim, "");
	value = value.replace(/```(?:text|markdown)?\s*\n## RESULT[\s\S]*?## END\s*\n```/gi, "");
	value = value.replace(/^\s*- \*\*Do NOT include any emojis\. Emojis are banned\.\*\*\s*$/im, "");
	return value.replace(/\n{3,}/g, "\n\n").trim();
}

function stripTaskResultWrapper(task: string): string {
	let value = task.trim();
	// A task is data, not a second protocol authority. Once it starts emitting
	// a result template, discard that tail and append the canonical one below.
	value = value.replace(/\n?^\s*## RESULT\s*$[\s\S]*$/im, "");
	value = value.replace(/```(?:text|markdown)?\s*\n## RESULT[\s\S]*?## END\s*\n```/gi, "");
	value = value.replace(/\n?[-* ]*(?:Your final response|End with)[^\n]*(?:## RESULT|RESULT block)[^\n]*\n/gi, "\n");
	return value.replace(/\n{3,}/g, "\n\n").trim();
}

/** Backward-compatible text for callers that still need the protocol alone. */
export function buildAgentResultContractPrompt(): string {
	return `${buildWorkerInitialPrompt({ task: "(The coordinator will provide the task.)" })}\nThe verification line is an untrusted worker claim; independent verification is required before completion.`;
}

export interface ExtractedResult {
	found: boolean;
	result: string;
}

/**
 * Normalize common model formatting drift without spending another model turn.
 * Report content is preserved verbatim. Orchestrator callers may also recover
 * a non-empty plain-text report; this repairs transport syntax only and never
 * replaces independent semantic verification.
 * Deterministic repairs cover localized field labels, status/done aliases, a
 * missing role, missing summary, missing ## END, and a missing outer block.
 */
export interface ResultNormalizationOptions {
	/** Allow orchestrator to wrap a non-empty plain-text worker report. */
	allowUnstructured?: boolean;
	/** Process outcome used only to fill omitted mechanical fields. */
	exitCode?: number | null;
}

export function normalizeResultContract(
	text: string,
	role?: string,
	options: ResultNormalizationOptions = {},
): { text: string; changed: boolean; recovered?: boolean } | undefined {
	const extracted = extractResultBlock(text);
	if (!extracted.found) {
		if (!options.allowUnstructured || !text.trim()) return undefined;
		return synthesizeResultContract(text, role, options.exitCode);
	}
	const lines = extracted.result.split(/\r?\n/);
	// Workers may translate protocol field labels to match the task language.
	// Canonicalize common localized labels before applying the strict validator.
	const fieldAliases: Record<string, string> = {
		"role": "role", "角色": "role",
		"done": "done", "完成": "done",
		"status": "status", "状态": "status",
		"summary": "summary", "总结": "summary", "摘要": "summary",
	};
	// Status values drift far more often than the PASS|FAIL|BLOCKED enum;
	// map the common phrasings deterministically instead of repairing.
	const statusAliases: Record<string, string> = {
		"pass": "PASS", "success": "PASS", "succeeded": "PASS", "ok": "PASS", "complete": "PASS", "completed": "PASS", "通过": "PASS",
		"fail": "FAIL", "failed": "FAIL", "error": "FAIL", "failure": "FAIL", "错误": "FAIL", "失败": "FAIL",
		"blocked": "BLOCKED", "block": "BLOCKED", "阻塞": "BLOCKED",
	};
	const doneAliases: Record<string, "true" | "false"> = {
		"true": "true", "yes": "true", "y": "true", "done": "true", "completed": "true", "complete": "true", "successful": "true", "完成": "true", "已完成": "true", "是": "true",
		"false": "false", "no": "false", "n": "false", "not": "false", "incomplete": "false", "incompleted": "false", "未完成": "false", "未": "false", "否": "false",
	};
	let done: string | undefined;
	let summary = "";
	let doneIndex = -1;
	let doneFieldIndex = -1;
	let statusFieldIndex = -1;
	let hasValidStatus = false;
	const normalized = [...lines];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		const fieldMatch = line.match(/^([^:：]+)\s*[:：]\s*(.*)$/);
		const field = fieldMatch ? fieldAliases[fieldMatch[1].trim().toLowerCase()] : undefined;
		if (field && fieldMatch) normalized[i] = `${field}: ${fieldMatch[2].trim()}`;
		const canonicalLine = normalized[i].trim();
		const doneMatch = canonicalLine.match(/^done:\s*([^\s]+)(?:\s*[—–-]\s*(.+))?$/i);
		if (doneMatch) {
			doneFieldIndex = i;
			const mapped = doneAliases[doneMatch[1].toLowerCase()];
			if (mapped) {
				done = mapped;
				doneIndex = i;
				if (!summary && doneMatch[2]) summary = doneMatch[2].trim();
			}
		}
		const statusMatch = canonicalLine.match(/^status:\s*(\S+)/i);
		if (statusMatch) {
			statusFieldIndex = i;
			const mapped = statusAliases[statusMatch[1].toLowerCase()];
			if (mapped) {
				normalized[i] = `status: ${mapped}`;
				hasValidStatus = true;
			}
		}
		const summaryMatch = canonicalLine.match(/^summary:\s*(.*)$/i);
		if (summaryMatch?.[1]?.trim()) summary = summaryMatch[1].trim();
	}
	if (!done) {
		if (options.exitCode === undefined) return undefined;
		done = options.exitCode === 0 ? "true" : "false";
		if (doneFieldIndex >= 0) {
			doneIndex = doneFieldIndex;
			normalized[doneIndex] = `done: ${done}`;
		} else {
			doneIndex = normalized.length;
			normalized.push(`done: ${done}`);
		}
	} else {
		normalized[doneIndex] = `done: ${done}`;
	}
	if (!hasValidStatus && options.exitCode !== undefined) {
		const inferred = options.exitCode === 0 ? "PASS" : "FAIL";
		if (statusFieldIndex >= 0) normalized[statusFieldIndex] = `status: ${inferred}`;
		else normalized.splice(doneIndex + 1, 0, `status: ${inferred}`);
	}
	// Inject the spawn identity when the worker dropped the role line.
	const hasRole = normalized.some((line) => /^\s*role:\s*\S/i.test(line));
	const roleLine = role ? `role: ${role.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}` : "";
	if (!hasRole && roleLine) {
		normalized.splice(doneIndex + 1, 0, roleLine);
	}
	if (!normalized.some((line) => /^\s*summary:\s*\S/i.test(line))) {
		const fallback = summary || fallbackSummary(normalized);
		normalized.splice(doneIndex + 1 + (roleLine && !hasRole ? 1 : 0), 0, `summary: ${fallback}`);
	}
	const body = normalized.join("\n").trim();
	const canonical = `## RESULT\n${body}\n## END`;
	return { text: canonical, changed: canonical !== text.trim() };
}

/**
 * Wrap a non-empty worker report when model ignored the protocol entirely.
 * Process success supplies only mechanical fields; semantic completion still
 * belongs to the independent workflow verifier.
 */
function synthesizeResultContract(
	text: string,
	role: string | undefined,
	exitCode: number | null | undefined,
): { text: string; changed: boolean; recovered: true } {
	const resultRole = role?.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "worker";
	const done = exitCode === 0 ? "true" : "false";
	const status = exitCode === 0 ? "PASS" : "FAIL";
	const report = text.trim().replace(/\s+/g, " ").slice(0, 2_000);
	const summary = fallbackSummary([text]);
	const canonical = [
		"## RESULT",
		`role: ${resultRole}`,
		`done: ${done}`,
		`status: ${status}`,
		`summary: ${summary}`,
		"findings:",
		"- Orchestrator recovered a missing worker RESULT wrapper; semantic completion remains independently verified.",
		`- worker report: ${report}`,
		"files: none",
		"key_errors: none",
		"verification: not supplied in canonical worker format",
		"remaining: none",
		"## END",
	].join("\n");
	return { text: canonical, changed: true, recovered: true };
}

/** First findings bullet as a zero-token summary fallback. */
function fallbackSummary(lines: string[]): string {
	for (const line of lines) {
		const t = line.trim().replace(/^[-*]\s*/, "");
		if (t && t.length > 2 && !/^(role|done|status|summary|findings|files|key_errors|verification|remaining|external_research_needed|queries|reason):/i.test(t)) {
			return t.replace(/\s+/g, " ").slice(0, 160);
		}
	}
	return "Result returned; see findings.";
}

/**
 * Extract the LAST result block from a transcript. Models frequently add a
 * heading level, a colon, code-fence ticks, or translate the two markers.
 * Normalize those mechanical variants at this boundary; semantic fields are
 * still validated by checkResultCompliance.
 */
function isResultMarkerLine(line: string): boolean {
	return /^`{0,3}\s*#{1,6}\s*(?:RESULT|结果)\s*:?[`\s]*$/i.test(line.trim());
}

function isResultEndLine(line: string): boolean {
	return /^`{0,3}\s*#{1,6}\s*(?:END|结束)\s*[`\s]*$/i.test(line.trim());
}

export function extractResultBlock(text: string): ExtractedResult {
	if (!text) return { found: false, result: "" };
	const lines = text.split(/\r?\n/);
	let lastStart = -1;
	for (let i = 0; i < lines.length; i++) {
		if (isResultMarkerLine(lines[i])) lastStart = i;
	}
	if (lastStart === -1) return { found: false, result: "" };
	const body: string[] = [];
	for (let i = lastStart + 1; i < lines.length; i++) {
		if (isResultEndLine(lines[i])) break;
		body.push(lines[i]);
	}
	const result = body.join("\n").trim();
	return { found: result.length > 0, result };
}

/** Short one-line summary derived from the result block or transcript tail. */
export function resultOneLiner(fullText: string, resultText: string): string {
	const clean = (s: string) => s.replace(/\s+/g, " ").trim();
	const fromBlock = resultText || extractResultBlock(fullText).result;
	if (fromBlock) {
		const summary = clean(
			fromBlock.split("\n").find((l) => /^summary:/i.test(l.trim())) || "",
		);
		if (summary.length > 0) return summary.replace(/^summary:\s*/i, "").slice(0, 160);
		return clean(fromBlock).slice(0, 160);
	}
	if (fullText) {
		const last = clean(
			fullText
				.split("\n")
				.filter((l) => {
					const t = l.trim();
					return t && t !== RESULT_MARKER && t !== RESULT_END_MARKER;
				})
				.pop() || "",
		);
		if (last.length > 0) return last.slice(0, 160);
	}
	return "";
}

export interface ComposeAgentResultOptions {
	agent: string;
	status: "done" | "error";
	exitCode: number | null;
	elapsedMs: number;
	model?: string;
	/** Full merged transcript (text + stderr for failures). */
	outputText: string;
	/** Absolute path where the full transcript was persisted. */
	fullOutputPath: string;
	/** Fallback character budget. Defaults to MAX_RESULT_CHARS. */
	maxResultChars?: number;
	/** External CLIs cannot emit ## RESULT; skip the contract warning. */
	skipContract?: boolean;
}

export interface ComposedAgentResult {
	/** Compact but complete tool-result text for the parent context. */
	content: string;
	/** True when a canonical RESULT block was used for the handoff. */
	usedResult: boolean;
	/** True when the orchestrator repaired a plain or mechanically drifted report. */
	recovered: boolean;
	fullChars: number;
	resultChars: number;
	/** Non-empty only when deterministic recovery was impossible. */
	contractProblems: string[];
}

/**
 * Build the parent-visible tool result. Guarantees:
 * 1. The exact status + timing are always present.
 * 2. A canonical ## RESULT block is used when present or synthesized from a
 *    non-empty process result; empty output remains blocked.
 * 3. The path to the FULL transcript is always included. Recovered results
 *    remain independently subject to semantic workflow verification.
 */
export function composeAgentResult(
	opts: ComposeAgentResultOptions,
): ComposedAgentResult {
	const fullText = opts.outputText || "";
	const header = `[${opts.agent}] ${opts.status} in ${formatDuration(opts.elapsedMs)}${opts.model ? ` (${opts.model})` : ""}`;

	const normalized = opts.skipContract
		? undefined
		: normalizeResultContract(fullText, opts.agent, { allowUnstructured: true, exitCode: opts.exitCode });
	const contractText = normalized?.text || fullText;
	const { found, result } = extractResultBlock(contractText);

	let body: string;
	let usedResult = false;
	const compliance = opts.skipContract ? { ok: true, problems: [] as string[] } : checkResultCompliance(contractText);
	if (found && compliance.ok) {
		usedResult = true;
		body = `\n\n## RESULT\n${result}`;
	} else if (opts.skipContract) {
		usedResult = true;
		body = `\n\n${fullText || "(empty output)"}`;
	} else if (!compliance.ok) {
		// Fail closed at the parent boundary. Never forward a malformed result
		// block that could be partially parsed as a valid handoff.
		body = `\n\n[RESULT contract rejected]\n${compliance.problems.join("; ")}`;
	} else {
		body = `\n\n[no ## RESULT block found]\n${fullText || "(empty output)"}`;
	}

	const fullChars = fullText.length;
	const pointer = transcriptPointer({
		fullChars,
		path: opts.fullOutputPath,
		usedResult,
		truncated: false,
		incomplete: !compliance.ok,
	});

	let content = `${header}${body}${pointer}`;
	if (!compliance.ok && contractGateEnabled()) {
		content += `

⚠️ RESULT contract violated (${compliance.problems.join("; ")}) — read the archived transcript before acting on this result.`;
	}
	return {
		content,
		usedResult,
		recovered: !!normalized?.recovered,
		fullChars,
		resultChars: body.length,
		contractProblems: compliance.problems,
	};
}

function transcriptPointer(opts: {
	fullChars: number;
	path: string;
	usedResult: boolean;
	truncated: boolean;
	incomplete: boolean;
}): string {
	if (!opts.path) return "";
	const loc = `Archived transcript (${opts.fullChars} chars): ${opts.path}`;
	if (opts.usedResult && !opts.truncated && !opts.incomplete) {
		return `\n\n${loc}\nDo not read this file unless ## RESULT is missing a path or quote you need.`;
	}
	if (opts.usedResult && opts.truncated) {
		return `\n\n${loc}\nRESULT was truncated; read that file only for the omitted tail.`;
	}
	return `\n\n${loc}\nUse the read tool on that path for exact errors, diffs, and test output not shown above.`;
}

export interface ResultCompliance {
	ok: boolean;
	problems: string[];
}

/**
 * Deterministic, zero-token RESULT-contract gate. Tiber-inspired delivery
 * check, simplified to pure mechanics: a finished sub-agent transcript must
 * contain a ## RESULT block with role/done/status/summary fields and an exact
 * "## END" closer. Content quality is deliberately NOT judged here.
 */
export function checkResultCompliance(fullText: string): ResultCompliance {
	const text = fullText ?? "";
	if (!text.trim()) return { ok: false, problems: ["empty transcript"] };
	const extracted = extractResultBlock(text);
	if (!extracted.found) return { ok: false, problems: ["no ## RESULT block"] };
	const problems: string[] = [];
	const lines = text.split(/\r?\n/);
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (isResultMarkerLine(lines[i])) start = i;
	}
	let closed = false;
	for (let i = start + 1; i < lines.length; i++) {
		if (isResultEndLine(lines[i])) {
			closed = true;
			break;
		}
	}
	if (!closed) problems.push("block not closed with ## END");
	const block = extracted.result;
	if (!/(^|\n)\s*role:\s*[a-z0-9_-]+\s*($|\n)/i.test(block))
		problems.push('missing "role:" line');
	if (!/(^|\n)\s*done:\s*(true|false)\s*($|\n)/i.test(block))
		problems.push('missing "done:" line');
	if (!/(^|\n)\s*status:\s*(PASS|FAIL|BLOCKED)\s*($|\n)/i.test(block))
		problems.push('missing or invalid "status:" line');
	if (!/(^|\n)\s*summary:\s*\S/i.test(block)) problems.push('missing "summary:"');
	return { ok: problems.length === 0, problems };
}

/** Return failure only when recovery cannot produce a complete result. */
export function resultContractFailure(
	fullText: string,
	skipContract = false,
	role?: string,
	exitCode?: number | null,
): string | undefined {
	if (skipContract) return undefined;
	const normalized = normalizeResultContract(fullText, role, { allowUnstructured: exitCode !== undefined, exitCode });
	const compliance = checkResultCompliance(normalized?.text || fullText);
	return compliance.ok ? undefined : `worker result contract incomplete: ${compliance.problems.join("; ")}`;
}

/** Set PI_RESULT_CONTRACT_GATE=0 to silence warning lines (checks still run). */
export function contractGateEnabled(): boolean {
	return process.env.PI_RESULT_CONTRACT_GATE !== "0";
}

/** Persist the full transcript next to the agent session file. Returns the path. */
export function persistFullOutput(
	sessionDir: string,
	baseName: string,
	text: string,
): string {
	const dir = join(sessionDir, "outputs");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${baseName}.txt`);
	writeFileSync(path, text, "utf8");
	return path;
}

/** Build a run-scoped base name, e.g. "tester-17-m3k2a9". */
export function runBaseName(agentKey: string, runCount: number): string {
	return `${agentKey}-${runCount}-${Date.now().toString(36)}`;
}

export function ensureDir(p: string): void {
	mkdirSync(dirname(p), { recursive: true });
}
