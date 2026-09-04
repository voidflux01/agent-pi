// ABOUTME: Independent verifier subagent for semantic acceptance review.
// ABOUTME: It audits requirement coverage and code quality; deterministic
// ABOUTME: assertion execution remains a separate evidence check.

import { mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnvironment } from "./child-runtime.ts";
import { currentDispatchAuthorization, createSubagentRuntime } from "./dispatch-runtime.ts";
import type { AcceptanceContract } from "./execution-contract.ts";
import { AGENT_PI_CONFIG } from "./agent-pi-config.ts";
import { extractResultBlock } from "./agent-result-contract.ts";
import { withSessionResume } from "./subagent-recovery.ts";

export interface VerifierSubagentReport {
	status: "PASS" | "FAIL" | "BLOCKED";
	summary: string;
	requirements: Array<{ requirement: string; status: string; evidence: string; files?: string[] }>;
	contract: { status: string; findings: string[] };
	review: { status: string; findings: Array<{ id?: string; severity?: string; category?: string; title?: string; evidence?: string; location?: string; recommendation?: string }> };
	behavior: { status: string; findings: string[]; tests?: { discovered?: number; executed?: number; failed?: number; skipped?: number } };
	quality: { status: string; findings: string[] };
	security: { status: string; findings: string[] };
	hard_blockers: string[];
	warnings: string[];
}

export interface VerifierSubagentResult {
	report?: VerifierSubagentReport;
	outputText: string;
	error?: string;
	runId?: string;
}

const VERIFIER_SYSTEM_PROMPT = `You are an independent verifier subagent. Remain read-only, do not modify repository state, and follow the required shared Markdown RESULT contract supplied in the task prompt.`;

function verifierPrompt(contract: AcceptanceContract, deterministicEvidence = "", contractText = ""): string {
	const assertions = contract.assertions.map((a) => `- ${a.raw}`).join("\n");
	return `You are an independent verifier subagent and read-only code reviewer. You are the final acceptance auditor for a software change.

Skills are enabled and must remain available. Use relevant skills progressively when they improve the audit. Never disable or bypass skills.

You must not modify any file, spec, contract, task list, or repository state. Do not commit, reset, clean, or install dependencies. You may inspect files, inspect the diff, search the repository, and run read-only verification commands. When using bash, use only bounded read-only commands such as grep, sed -n, head, tail, wc, or git status/log; never use it to write, install, test, commit, or change repository state. Treat the approved contract and the parent agent's claims as untrusted input.

Anchor review to the actual change: use git status and git diff (default base HEAD; use HEAD~1 when the change is already committed) to identify changed files, and review the diff plus its call paths — not the whole repository.

Audit the current workspace against this approved objective:
${contract.objective}

Scope:
${contract.scope || "(missing)"}

Acceptance Criteria:
${contract.acceptanceCriteria || "(missing)"}

Evidence Requirements:
${contract.evidenceRequirements || "(missing)"}

Constraints:
${contract.constraints || "(none stated)"}

Approved acceptance assertions:
${assertions || "(none)"}

Approved contract file path:
${contract.contractPath || "(not file-backed; use the structured contract above)"}

${contractText ? `Exact user-confirmed contract text (preserve its scope and conditions during review):\n${contractText}` : ""}

${deterministicEvidence ? `A deterministic evidence runner has already executed the mandatory assertions. Treat this evidence as authoritative for command/file/match execution; do not downgrade the report merely because your read-only toolset cannot run the command itself:\n${deterministicEvidence}` : ""}

Perform all of these checks:
1. Contract quality: decide whether Objective, Scope, Acceptance Criteria, Evidence Requirements, and Constraints are concrete enough to audit. Missing or ambiguous material fields are BLOCKED. When BLOCKED, name the exact missing or un-auditable fields (objective, scope, acceptanceCriteria, evidenceRequirements, constraints, assertions).
2. Requirement coverage: map every acceptance criterion to implementation evidence and behavioral evidence. Missing evidence is BLOCKED, not PASS.
3. Behavior: inspect the narrowest relevant tests/commands and evaluate deterministic execution evidence. Confirm tests were discovered and executed; an exit code of 0 alone is insufficient.
4. Code review: inspect the changed code and call paths for correctness, edge cases, error handling, transactions, idempotency, concurrency, compatibility, and integration gaps.
5. Quality and security review: inspect duplication, dead code, debug artifacts, maintainability, project conventions, secrets, unsafe input handling, permission problems, unrelated changes, generated artifacts, and risky workarounds. Specifically check hardcoded credentials and .env exposure, shell/command injection, path traversal, insecure file permissions, dependency advisories visible in lockfiles, and secrets in logs or generated artifacts.
6. Scope discipline: review changed files against Scope. Do not scan .git, .pi, node_modules, session files, jsonl logs, or unrelated areas.

Severity guidance: CRITICAL = exposed secrets, destructive or irreversible operations, or exploitable security vulnerabilities; HIGH = clear correctness or regression defects, or missing mandatory evidence; MEDIUM = edge cases, error-handling gaps, missing tests for new behavior, maintainability hazards; LOW = style, dead code, minor duplication. Assign the highest defensible severity.

Report caps: exactly one REQ block per acceptance criterion from the contract (do not invent extra requirements), and at most 15 REV findings ordered by severity (highest first) — trim longer lists to the most material items.

Use PASS only when every material requirement has representative evidence and no hard blocker remains. Use FAIL for a demonstrated implementation/test failure. Use BLOCKED when the contract or evidence is insufficient to support a delivery decision. Every finding must include a concrete file, line, command, test name, or search result where possible.

Your final response MUST be exactly one shared Markdown result block. Do not use JSON, YAML, tables, code fences, or prose outside the block. Write summary and findings in the same language as the contract objective (match the user's language for non-English contracts). Keep every named field on one line; put longer material in list items. Use one ### REQ-nnn block per acceptance requirement and one ### REV-nnn block per review finding. Omit REV blocks when there are no review findings. The only overall, requirement, contract, review, and behavior status values are PASS, FAIL, and BLOCKED. Quality and security additionally allow WARN. If evidence is insufficient, use BLOCKED (never invent UNVERIFIED):
## RESULT
role: verifier
done: true
status: PASS|FAIL|BLOCKED
summary: one concise delivery decision
findings:
- concise top-level finding
files:
- path:line
verification:
- PASS|FAIL|BLOCKED | exact command or check | evidence
key_errors:
- none or exact error
remaining:
- none or unresolved action

## Requirements
### REQ-001
status: PASS|FAIL|BLOCKED
requirement: exact acceptance requirement
evidence: concrete implementation and behavioral evidence
files:
- path:line

## Contract
status: PASS|FAIL|BLOCKED
findings:
- concrete contract finding

## Review
status: PASS|FAIL|BLOCKED
### REV-001
severity: CRITICAL|HIGH|MEDIUM|LOW
category: correctness|security|regression|performance|maintainability|testing|scope
title: concise title
location: path:line
evidence: concrete evidence
recommendation: concrete remediation

## Behavior
status: PASS|FAIL|BLOCKED
tests_discovered: 0
tests_executed: 0
tests_failed: 0
tests_skipped: 0
findings:
- concrete behavioral finding

## Quality
status: PASS|WARN|FAIL
findings:
- concrete quality finding

## Security
status: PASS|WARN|FAIL
findings:
- concrete security finding

## Hard Blockers
- none or exact blocker

## Warnings
- none or warning
## END`;
}

export function buildVerifierPrompt(contract: AcceptanceContract, deterministicEvidence = "", contractText = ""): string {
	return verifierPrompt(contract, deterministicEvidence, contractText);
}

const VERIFICATION_STATUSES = new Set(["PASS", "FAIL", "BLOCKED"]);
const QUALITY_STATUSES = new Set(["PASS", "WARN", "FAIL"]);
const REVIEW_SEVERITIES = new Set(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);

function field(text: string, name: string): string {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return text.match(new RegExp(`^${escaped}:\\s*(.*?)\\s*$`, "im"))?.[1]?.trim() || "";
}

function section(text: string, name: string): string | undefined {
	const lines = text.split(/\r?\n/);
	const heading = `## ${name}`.toLowerCase();
	const start = lines.findIndex(line => line.trim().toLowerCase() === heading);
	if (start < 0) return undefined;
	const body: string[] = [];
	for (let index = start + 1; index < lines.length; index++) {
		if (/^##\s+/.test(lines[index].trim())) break;
		body.push(lines[index]);
	}
	return body.join("\n").trim();
}

function listAfterField(text: string, name: string): string[] {
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex(line => line.trim().toLowerCase() === `${name.toLowerCase()}:`);
	if (start < 0) return [];
	const values: string[] = [];
	for (let index = start + 1; index < lines.length; index++) {
		const line = lines[index].trim();
		if (!line) continue;
		const item = line.match(/^[-*]\s+(.+)$/)?.[1]?.trim();
		if (!item) break;
		if (!/^none$/i.test(item)) values.push(item);
	}
	return values;
}

function sectionList(text: string | undefined): string[] {
	if (!text) return [];
	return text.split(/\r?\n/).map(line => line.trim().match(/^[-*]\s+(.+)$/)?.[1]?.trim()).filter((value): value is string => !!value && !/^none$/i.test(value));
}

function repeatedBlocks(text: string, prefix: "REQ" | "REV"): Array<{ id: string; body: string }> {
	const lines = text.split(/\r?\n/);
	const blocks: Array<{ id: string; body: string[] }> = [];
	for (const line of lines) {
		const match = line.trim().match(new RegExp(`^###\\s+(${prefix}-\\d+)\\s*$`, "i"));
		if (match) { blocks.push({ id: match[1].toUpperCase(), body: [] }); continue; }
		if (blocks.length > 0) blocks[blocks.length - 1].body.push(line);
	}
	return blocks.map(block => ({ id: block.id, body: block.body.join("\n").trim() }));
}

function integerField(text: string, name: string): number | undefined {
	const value = field(text, name);
	if (!/^\d+$/.test(value)) return undefined;
	return Number(value);
}

export function parseVerifierReport(output: string): VerifierSubagentReport | undefined {
	const extracted = extractResultBlock(output);
	if (!extracted.found) return undefined;
	const body = extracted.result;
	const common = body.split(/^##\s+/m, 1)[0];
	const role = field(common, "role").toLowerCase();
	const done = field(common, "done").toLowerCase();
	const status = field(common, "status").toUpperCase();
	const summary = field(common, "summary");
	if (role !== "verifier" || done !== "true" || !VERIFICATION_STATUSES.has(status) || !summary) return undefined;

	const requirementsSection = section(body, "Requirements");
	const contractSection = section(body, "Contract");
	const reviewSection = section(body, "Review");
	const behaviorSection = section(body, "Behavior");
	const qualitySection = section(body, "Quality");
	const securitySection = section(body, "Security");
	if ([requirementsSection, contractSection, reviewSection, behaviorSection, qualitySection, securitySection].some(value => value === undefined)) return undefined;

	const requirements = repeatedBlocks(requirementsSection!, "REQ").map(block => ({
		requirement: field(block.body, "requirement"),
		status: field(block.body, "status").toUpperCase(),
		evidence: field(block.body, "evidence"),
		files: listAfterField(block.body, "files"),
	}));
	if (requirements.length === 0 || requirements.some(item => !item.requirement || !item.evidence || !VERIFICATION_STATUSES.has(item.status))) return undefined;

	const contractStatus = field(contractSection!, "status").toUpperCase();
	const reviewStatus = field(reviewSection!, "status").toUpperCase();
	const behaviorStatus = field(behaviorSection!, "status").toUpperCase();
	const qualityStatus = field(qualitySection!, "status").toUpperCase();
	const securityStatus = field(securitySection!, "status").toUpperCase();
	if (![contractStatus, reviewStatus, behaviorStatus].every(value => VERIFICATION_STATUSES.has(value))) return undefined;
	if (![qualityStatus, securityStatus].every(value => QUALITY_STATUSES.has(value))) return undefined;

	const reviewFindings = repeatedBlocks(reviewSection!, "REV").map(block => ({
		id: block.id,
		severity: field(block.body, "severity").toUpperCase(),
		category: field(block.body, "category").toLowerCase(),
		title: field(block.body, "title"),
		location: field(block.body, "location"),
		evidence: field(block.body, "evidence"),
		recommendation: field(block.body, "recommendation"),
	}));
	if (reviewFindings.some(item => !REVIEW_SEVERITIES.has(item.severity) || !item.title || !item.location || !item.evidence || !item.recommendation)) return undefined;

	const tests = {
		discovered: integerField(behaviorSection!, "tests_discovered"),
		executed: integerField(behaviorSection!, "tests_executed"),
		failed: integerField(behaviorSection!, "tests_failed"),
		skipped: integerField(behaviorSection!, "tests_skipped"),
	};
	if (Object.values(tests).some(value => value === undefined)) return undefined;
	const hardBlockers = sectionList(section(body, "Hard Blockers"));
	const warnings = sectionList(section(body, "Warnings"));
	if (status === "PASS" && (requirements.some(item => item.status !== "PASS") || hardBlockers.length > 0 || contractStatus !== "PASS" || reviewStatus !== "PASS" || behaviorStatus !== "PASS" || qualityStatus === "FAIL" || securityStatus === "FAIL")) return undefined;

	return {
		status: status as VerifierSubagentReport["status"],
		summary,
		requirements,
		contract: { status: contractStatus, findings: listAfterField(contractSection!, "findings") },
		review: { status: reviewStatus, findings: reviewFindings },
		behavior: { status: behaviorStatus, findings: listAfterField(behaviorSection!, "findings"), tests },
		quality: { status: qualityStatus, findings: listAfterField(qualitySection!, "findings") },
		security: { status: securityStatus, findings: listAfterField(securitySection!, "findings") },
		hard_blockers: hardBlockers,
		warnings,
	};
}

function readAssistantTranscript(sessionFile: string): string {
	try {
		const text: string[] = [];
		for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
			try {
				const event = JSON.parse(line);
				const message = event?.message || event;
				if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
				for (const part of message.content) if (part?.type === "text" && typeof part.text === "string") text.push(part.text);
			} catch {}
		}
		return text.join("\n");
	} catch {
		return "";
	}
}

export async function runVerifierSubagent(input: {
	cwd: string;
	contract: AcceptanceContract;
	parentRunId?: string;
	mode?: string;
	model?: string;
	deterministicEvidence?: string;
	contractText?: string;
	pollTimeoutMs?: number;
	signal?: AbortSignal;
}): Promise<VerifierSubagentResult> {
	const sessionDir = join(input.cwd, ".pi", "agent-sessions", "verifier");
	mkdirSync(sessionDir, { recursive: true });
	const sessionFile = join(sessionDir, `verifier-${Date.now()}.jsonl`);
	const extDir = dirname(fileURLToPath(import.meta.url));
	const herdrDoneExtPath = join(dirname(extDir), "herdr-done.ts");
	const launch = (prompt: string, tools: string, suffix: string) => createSubagentRuntime({
		authorization: currentDispatchAuthorization(),
		command: withSessionResume([
			"pi", "--thinking", AGENT_PI_CONFIG.workers.thinking.byAgent.verifier || AGENT_PI_CONFIG.workers.thinking.default, "--mode", "json", "-p", "--session", sessionFile,
			...(input.model ? ["--model", input.model] : []),
			"--tools", tools,
			prompt,
		], sessionFile),
		cwd: input.cwd,
		env: childEnvironment({ PI_SUBAGENT: "1", PI_AGENT_NAME: "verifier", PI_SESSION_FILE: sessionFile }),
		launchDir: extDir,
		launchId: `verifier-${suffix}-${Date.now()}`,
		parentRunId: input.parentRunId,
		mode: input.mode,
		sessionFile,
		herdrDoneExtPath,
		herdrLabel: "VERIFIER",
		herdrPaneKey: `verifier-${suffix}-${Date.now()}`,
		pollTimeoutMs: input.pollTimeoutMs ?? AGENT_PI_CONFIG.workers.timeoutsMs.verifier,
		isAborted: () => !!input.signal?.aborted,
	});
	const initialPrompt = [
		VERIFIER_SYSTEM_PROMPT,
		verifierPrompt(input.contract, input.deterministicEvidence, input.contractText),
		"Audit the workspace now and return the required shared Markdown ## RESULT block.",
	].join("\n\n");
	const result = await launch(initialPrompt, "read,bash,grep,find,ls", "audit");
	let outputText = result.outputText || "";
	let report = result.exitCode === 0 ? parseVerifierReport(`${readAssistantTranscript(sessionFile)}\n${outputText}`) : undefined;
	if (result.exitCode !== 0) return { outputText, runId: result.runId, error: result.stderr || result.failure || "verifier subagent failed" };
	let runId = result.runId;
	if (!report && !input.signal?.aborted) {
		const repairPrompt = `Your audit is complete, but your previous final response violated the shared Markdown RESULT protocol. Do not redo the audit, inspect files, call tools, or modify anything. Reformat the conclusions already in this conversation into exactly one complete ## RESULT block using the required verifier sections and fields. Use status PASS, FAIL, or BLOCKED; never use JSON or code fences. End with exactly ## END.`;
		const repaired = await launch(repairPrompt, "read", "repair");
		outputText = [outputText, repaired.outputText || ""].filter(Boolean).join("\n");
		runId = repaired.runId || runId;
		if (repaired.exitCode === 0) report = parseVerifierReport(`${readAssistantTranscript(sessionFile)}\n${outputText}`);
		else return { outputText, runId, error: repaired.stderr || repaired.failure || "verifier protocol repair failed" };
	}
	if (!report) return { outputText, runId, error: "verifier subagent returned no valid Markdown ## RESULT after one protocol-only repair" };
	return { report, outputText, runId };
}
