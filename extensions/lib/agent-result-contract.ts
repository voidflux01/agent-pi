// ABOUTME: Precision-preserving sub-agent result contract.
// ABOUTME: Sub-agents end their final message with a ## RESULT block; the
// ABOUTME: orchestrator extracts that block for the parent context while the
// ABOUTME: FULL transcript is always persisted to disk and pointed to, so
// ABOUTME: token savings never silently drop information.
// ABOUTME: Shared by agent-team.ts, agent-chain.ts, and pipeline-team.ts.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const RESULT_MARKER = "## RESULT";
export const RESULT_END_MARKER = "## END";

/** Fallback budgets when a sub-agent did not emit a ## RESULT block. */
export const FALLBACK_TAIL_CHARS = 2000;
export const FALLBACK_HEAD_CHARS = 1000;
/** Hard cap for an extracted ## RESULT block (rarely hit). */
export const MAX_RESULT_CHARS = 3500;

/**
 * System-prompt text appended to EVERY sub-agent, unconditionally.
 * The block is an INDEX, not a space-saver: the coordinator reads it, and the
 * full transcript stays available on disk, so nothing has to be shortened.
 */
export function buildAgentResultContractPrompt(): string {
	return `\n\n## Final Result Format (REQUIRED)\n
Your final message MUST end with a block starting on its own line with \`## RESULT\`:\n
\`\`\`
## RESULT
done: true|false
summary: <3-6 lines covering ALL of the fields below>
- files: <every file you created or modified, one path per line>
- key errors: <exact error messages you hit, quoted verbatim, and how each was resolved>
- verification: <exact commands/tests you ran and their exact outcome>
- remaining: <what is still open or uncertain, or "none">
## END
\`\`\`

The ## RESULT block is the index the coordinator reads. Include everything the coordinator needs to act: exact file paths, exact error text, exact test results. Do NOT shorten your work to fit this block — your full transcript is preserved and can be read later. If the task FAILED, set done: false and put the exact error under "key errors". End the block with a line containing exactly: ## END`;
}

export interface ExtractedResult {
	found: boolean;
	result: string;
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
	if (resultText) {
		const first = clean(resultText.split("\n").find((l) => /^summary:/i.test(l.trim())) || "");
		if (first.length > 0) return first.slice(0, 160);
		return clean(resultText).slice(0, 160);
	}
	if (fullText) {
		const last = clean(fullText.split("\n").filter((l) => l.trim()).pop() || "");
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
 * 3. The path to the FULL transcript is always included, with an explicit
 *    note about what is NOT shown, so the parent can read exact details.
 */
export function composeAgentResult(opts: ComposeAgentResultOptions): ComposedAgentResult {
	const maxResultChars = opts.maxResultChars ?? MAX_RESULT_CHARS;
	const fullText = opts.outputText || "";
	const secs = Math.round(opts.elapsedMs / 1000);
	const header = `[${opts.agent}] ${opts.status} in ${secs}s${opts.model ? ` (${opts.model})` : ""}`;

	const { found, result } = extractResultBlock(fullText);

	let body: string;
	let usedResult = false;
	if (found) {
		usedResult = true;
		if (result.length > maxResultChars) {
			body = `\n\n## RESULT\n${result.slice(0, maxResultChars)}\n\n[RESULT block truncated at ${maxResultChars} chars; full transcript preserved]`;
		} else {
			body = `\n\n## RESULT\n${result}`;
		}
	} else {
		const tail = fullText.slice(-FALLBACK_TAIL_CHARS);
		const head = fullText.length > FALLBACK_TAIL_CHARS + FALLBACK_HEAD_CHARS
			? fullText.slice(0, FALLBACK_HEAD_CHARS)
			: "";
		body = `\n\n[no ## RESULT block found — showing ${head ? `first ${FALLBACK_HEAD_CHARS} chars and ` : ""}last ${FALLBACK_TAIL_CHARS} chars]\n${head ? `\n--- transcript head ---\n${head}\n` : ""}\n--- transcript tail ---\n${tail}`;
	}

	const fullChars = fullText.length;
	const pointer = `\n\nFull transcript (${fullChars} chars): ${opts.fullOutputPath}\nUse the read tool on that path for exact errors, diffs, and test output not shown above.`;

	let content = `${header}${body}${pointer}`;
	const compliance = checkResultCompliance(fullText);
	if (!compliance.ok && contractGateEnabled()) {
		content += `

⚠️ RESULT contract violated (${compliance.problems.join("; ")}) — read the full transcript before acting on this result.`;
	}
	return {
		content,
		usedResult,
		fullChars,
		resultChars: body.length,
		contractProblems: compliance.problems,
	};
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
	if (!/(^|\n)\s*done:\s*(true|false)\s*($|\n)/i.test(text)) problems.push('missing "done:" line');
	if (!/(^|\n)\s*summary:\s*\S/i.test(text)) problems.push('missing "summary:"');
	return { ok: problems.length === 0, problems };
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

/** Build a run-scoped base name, e.g. "tester-17" or "chain-reviewer-3". */
export function runBaseName(agentKey: string, runCount: number): string {
	return `${agentKey}-${runCount}`;
}

export function ensureDir(p: string): void {
	mkdirSync(dirname(p), { recursive: true });
}
