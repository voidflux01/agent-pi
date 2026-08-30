// ABOUTME: Acceptance contract = executable assertion checklist from approved plan/spec.
// ABOUTME: Only [cmd]/[file]/[match] assertions count toward PASS; natural-language
// ABOUTME: items are advisory and can never trigger completion. Identity is a SHA-256
// ABOUTME: of the full approved source text (matches planApprovalBinding fingerprints).

import { createHash } from "node:crypto";

export type VerificationStatus = "PASS" | "FAIL" | "BLOCKED";

export type ContractAssertion =
	| { kind: "cmd"; raw: string; command: string; args: string[] }
	| { kind: "file"; raw: string; path: string }
	| { kind: "match"; raw: string; pattern: string; path: string }
	| { kind: "advisory"; raw: string; text: string };

export interface AcceptanceContract {
	version: 2;
	source: "plan" | "pipeline" | "spec";
	objective: string;
	assertions: ContractAssertion[];
	/** cmd/file/match only — the assertions that decide PASS. */
	mandatory: ContractAssertion[];
	fingerprint: string;
}

/** Same algorithm as approval-gate fingerprintContent — full text, not a second hash of fields. */
export function planFingerprint(markdown: string): string {
	return createHash("sha256").update(markdown, "utf8").digest("hex");
}

function extractSection(markdown: string, heading: string): string | undefined {
	const re = new RegExp(`^##\\s+${heading}\\s*$`, "im");
	const match = re.exec(markdown);
	if (!match) return undefined;
	const start = match.index + match[0].length;
	const rest = markdown.slice(start);
	const next = rest.search(/^##\s+/m);
	return (next === -1 ? rest : rest.slice(0, next)).trim();
}

function parseListItems(body: string): string[] {
	const items: string[] = [];
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		const match = trimmed.match(/^(?:[-*]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+)(.+)$/);
		if (match?.[1]) items.push(match[1].trim());
	}
	return items.filter(item => item.length > 0);
}

/** Parse one checklist item into a typed assertion. Unknown shapes degrade to advisory. */
export function parseAssertion(raw: string): ContractAssertion {
	const advisoryText = raw.replace(/^advisory\s*[:\-]\s*/i, "").trim();
	const advisory: ContractAssertion = { kind: "advisory", raw, text: advisoryText };
	const marker = raw.match(/^\[(cmd|file|match)\]\s+(.+)$/i);
	if (!marker) return advisory;
	const kind = marker[1].toLowerCase();
	const body = marker[2].trim();
	if (kind === "cmd") {
		const tokens = body.split(/\s+/).filter(Boolean).map(stripQuotes);
		const [command, ...args] = tokens;
		return command ? { kind: "cmd", raw, command, args } : advisory;
	}
	if (kind === "file") {
		return body ? { kind: "file", raw, path: body } : advisory;
	}
	if (kind === "match") {
		const sep = body.lastIndexOf("::");
		const pattern = body.slice(0, sep).trim();
		const path = body.slice(sep + 2).trim();
		if (sep > 0 && pattern && path) return { kind: "match", raw, pattern, path };
		return advisory;
	}
	return advisory;
}

/** Strip one balanced pair of surrounding quotes (no shell, so quotes are quoting only). */
function stripQuotes(token: string): string {
	const first = token[0];
	if ((first === '"' || first === "'") && token.length > 1 && token[token.length - 1] === first) {
		return token.slice(1, -1);
	}
	return token;
}

export function isMandatory(assertion: ContractAssertion): boolean {
	return assertion.kind === "cmd" || assertion.kind === "file" || assertion.kind === "match";
}

/** Extract typed assertions from the first section (of the given headings) that has list items. */
export function extractContractAssertions(markdown: string, headings: string[]): ContractAssertion[] {
	for (const heading of headings) {
		const items = parseListItems(extractSection(markdown, heading) || "");
		if (items.length === 0) continue;
		return items.map(parseAssertion);
	}
	return [];
}

function buildContract(
	markdown: string,
	source: AcceptanceContract["source"],
	headings: string[],
): AcceptanceContract | { error: "incomplete" } {
	const assertions = extractContractAssertions(markdown, headings);
	const mandatory = assertions.filter(isMandatory);
	// No executable assertions → not verifiable. Advisory items alone must never PASS.
	if (mandatory.length === 0) return { error: "incomplete" };
	const objective = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim()
		|| markdown.split("\n").find(line => line.trim())?.trim()
		|| "untitled";
	return {
		version: 2,
		source,
		objective,
		assertions,
		mandatory,
		fingerprint: planFingerprint(markdown),
	};
}

/** Placeholder for approved text with no executable assertions. Gates with INCOMPLETE; never PASSes. */
export function emptyContract(markdown: string, source: AcceptanceContract["source"]): AcceptanceContract {
	const objective = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim()
		|| markdown.split("\n").find(line => line.trim())?.trim()
		|| "untitled";
	return { version: 2, source, objective, assertions: [], mandatory: [], fingerprint: planFingerprint(markdown) };
}

/** Plan/pipeline contract: ## Contract first, legacy ## Verification fallback. */
export function bindAcceptanceContract(
	markdown: string,
	source: "plan" | "pipeline",
): AcceptanceContract | { error: "incomplete" } {
	return buildContract(markdown, source, ["Contract", "Verification"]);
}

/** SPEC spec.md contract: ## Requirements first, legacy ## Acceptance Criteria fallback. */
export function bindSpecContract(markdown: string): AcceptanceContract | { error: "incomplete" } {
	return buildContract(markdown, "spec", ["Requirements", "Acceptance Criteria"]);
}