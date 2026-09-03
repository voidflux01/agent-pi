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
 * A worker that omitted ## RESULT still has a complete archive for recovery,
 * but its noisy fallback (tool help, repeated logs, and raw diffs) must not
 * become instructions for the next worker.
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
	return [
		role,
		stripEmbeddedResultProtocol(opts.rolePrompt),
		"Complete the task below using only the tools and scope provided. Do not ask the coordinator to repeat work you can finish yourself.",
		"",
		"Task:",
		stripTaskResultWrapper(opts.task),
		"",
		opts.additionalInstructions?.trim(),
		"",
		"Return one result block at the end. Put detailed investigation results, file:line references, and code snippets under findings; summary is only a short index. Do not emit any other result block.",
		"## RESULT",
		"done: true|false",
		"summary: one or two lines describing the outcome",
		"findings:",
		"- detailed findings, evidence, and relevant code snippets",
		"external_research_needed: true|false",
		"queries: omit when false; focused questions when true",
		"reason: omit when false; blocking external fact when true",
		"files: none or every created/modified path",
		"key errors: none or exact errors and resolutions",
		"verification: exact commands/tests and their outcome, or not run",
		"remaining: none or unresolved items",
		"## END",
		"Do not put prose after ## END. If the task failed, use done: false and record the exact blocker under key errors and remaining.",
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
 * Only a RESULT block is normalized; report content is preserved verbatim.
 */
export function normalizeResultContract(text: string): { text: string; changed: boolean } | undefined {
	const extracted = extractResultBlock(text);
	if (!extracted.found) return undefined;
	const lines = extracted.result.split(/\r?\n/);
	let done: string | undefined;
	let summary = "";
	let doneIndex = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		const doneMatch = line.match(/^done:\s*(true|false)(?:\s*[—–-]\s*(.+))?$/i);
		if (doneMatch) {
			done = doneMatch[1].toLowerCase();
			doneIndex = i;
			if (!summary && doneMatch[2]) summary = doneMatch[2].trim();
		}
		const summaryMatch = line.match(/^summary:\s*(.*)$/i);
		if (summaryMatch?.[1]?.trim()) summary = summaryMatch[1].trim();
	}
	if (!done) return undefined;
	const normalized = [...lines];
	if (doneIndex >= 0) normalized[doneIndex] = `done: ${done}`;
	if (!lines.some((line) => /^\s*summary:\s*\S/i.test(line))) {
		normalized.splice(doneIndex + 1, 0, `summary: ${summary || "Result returned; see findings."}`);
	}
	const body = normalized.join("\n").trim();
	const canonical = `## RESULT\n${body}\n## END`;
	return { text: canonical, changed: canonical !== text.trim() };
}

/**
 * Extract the LAST ## RESULT block from a transcript.
 * The block runs from the marker to a line equal to ## END, or to EOF.
 * Returns the block text (marker and END line stripped), trimmed.
 */
export function extractResultBlock(text: string): ExtractedResult {
	if (!text || !text.includes(RESULT_MARKER)) {
		return { found: false, result: "" };
	}
	const lines = text.split(/\r?\n/);
	let lastStart = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() === RESULT_MARKER) {
			lastStart = i;
		}
	}
	if (lastStart === -1) return { found: false, result: "" };
	const body: string[] = [];
	for (let i = lastStart + 1; i < lines.length; i++) {
		if (lines[i].trim() === RESULT_END_MARKER) break;
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
	/** True when a ## RESULT block was found and used. */
	usedResult: boolean;
	fullChars: number;
	resultChars: number;
	/** Non-empty when the transcript broke the ## RESULT contract. */
	contractProblems: string[];
}

/**
 * Build the parent-visible tool result. Guarantees:
 * 1. The exact status + timing are always present.
 * 2. A ## RESULT block is used when present; otherwise a tail+head fallback
 *    with an explicit marker — never an empty result.
 * 3. The path to the FULL transcript is always included. When ## RESULT is
 *    usable, the parent is told not to read it; otherwise it is told to.
 */
export function composeAgentResult(
	opts: ComposeAgentResultOptions,
): ComposedAgentResult {
	const fullText = opts.outputText || "";
	const header = `[${opts.agent}] ${opts.status} in ${formatDuration(opts.elapsedMs)}${opts.model ? ` (${opts.model})` : ""}`;

	const normalized = opts.skipContract ? undefined : normalizeResultContract(fullText);
	const contractText = normalized?.text || fullText;
	const { found, result } = extractResultBlock(contractText);

	let body: string;
	let usedResult = false;
	if (found) {
		usedResult = true;
		body = `\n\n## RESULT\n${result}`;
	} else if (opts.skipContract) {
		usedResult = true;
		body = `\n\n${fullText || "(empty output)"}`;
	} else {
		body = `\n\n[no ## RESULT block found]\n${fullText || "(empty output)"}`;
	}

	const fullChars = fullText.length;
	const compliance = opts.skipContract ? { ok: true, problems: [] as string[] } : checkResultCompliance(contractText);
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
 * contain a ## RESULT block with a "done:" line, a "summary:" line, and an
 * exact "## END" closer. Content quality is deliberately NOT judged here.
 */
export function checkResultCompliance(fullText: string): ResultCompliance {
	const text = fullText ?? "";
	if (!text.trim()) return { ok: false, problems: ["empty transcript"] };
	const { found } = extractResultBlock(text);
	if (!found) return { ok: false, problems: ["no ## RESULT block"] };
	const problems: string[] = [];
	const lines = text.split(/\r?\n/);
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() === RESULT_MARKER) start = i;
	}
	let closed = false;
	for (let i = start + 1; i < lines.length; i++) {
		if (lines[i].trim() === RESULT_END_MARKER) {
			closed = true;
			break;
		}
	}
	if (!closed) problems.push("block not closed with ## END");
	if (!/(^|\n)\s*done:\s*(true|false)\s*($|\n)/i.test(text))
		problems.push('missing "done:" line');
	if (!/(^|\n)\s*summary:\s*\S/i.test(text)) problems.push('missing "summary:"');
	return { ok: problems.length === 0, problems };
}

/** A coordinator may advance only when the worker emitted a complete result. */
export function resultContractFailure(fullText: string, skipContract = false): string | undefined {
	if (skipContract) return undefined;
	const normalized = normalizeResultContract(fullText);
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
