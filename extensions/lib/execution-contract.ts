// ABOUTME: Acceptance contract = executable commands plus explainable task criteria.
// ABOUTME: Only [cmd] assertions enter the deterministic PASS decision.

import { createHash } from "node:crypto";
import { resolve } from "node:path";

export type VerificationStatus = "PASS" | "FAIL" | "BLOCKED";
export type ContractAssertion =
	| { kind: "cmd"; raw: string; command: string; args: string[] }
	| { kind: "advisory"; raw: string; text: string };

export interface AcceptanceContract {
	version: 3;
	source: "plan" | "pipeline" | "spec";
	objective: string;
	scope: string;
	acceptanceCriteria: string;
	evidenceRequirements: string;
	constraints: string;
	/** Exact approved Markdown file used as the contract source, when file-backed. */
	contractPath?: string;
	assertions: ContractAssertion[];
	/** [cmd] only — the assertions that decide deterministic PASS. */
	mandatory: ContractAssertion[];
	fingerprint: string;
}

export function planFingerprint(markdown: string): string {
	return createHash("sha256").update(markdown, "utf8").digest("hex");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractSection(markdown: string, heading: string): string | undefined {
	// Plan contracts live below `## Contract`, so their fields are `###`
	// headings. Also accept top-level `##` fields for older standalone
	// contracts. A section ends at the next heading of the same or higher
	// level, not at a deeper subsection.
	const re = new RegExp(`^(#{2,6})\\s+${escapeRegExp(heading)}\\s*$`, "im");
	const match = re.exec(markdown);
	if (!match) return undefined;
	const rest = markdown.slice(match.index + match[0].length);
	const level = match[1].length;
	const next = rest.search(new RegExp(`^#{1,${level}}\\s+`, "m"));
	return (next === -1 ? rest : rest.slice(0, next)).trim();
}

function sectionText(markdown: string, headings: string[]): string {
	for (const heading of headings) {
		const value = extractSection(markdown, heading);
		if (value) return value;
	}
	return "";
}

function parseListItems(body: string): string[] {
	const items: string[] = [];
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		const match = trimmed.match(/^(?:[-*]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+)(.+)$/);
		if (match?.[1]) items.push(match[1].trim());
	}
	return items.filter(Boolean);
}

function commandText(value: string): string {
	const trimmed = value.trim();
	const fenced = trimmed.match(/^(`+)([\s\S]*?)\1(?:\s*(?:→|->|—|-)\s+.*)?$/);
	if (fenced) return fenced[2].trim();
	const annotation = trimmed.search(/\s+(?:→|->|—)\s+/);
	return (annotation >= 0 ? trimmed.slice(0, annotation) : trimmed).trim();
}

/** Parse shell-like quoting without invoking a shell or expansion. */
function tokenizeCommand(input: string): string[] {
	const tokens: string[] = [];
	let token = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const char of input.trim()) {
		if (escaped) { token += char; escaped = false; continue; }
		if (char === "\\" && quote !== "'") { escaped = true; continue; }
		if (quote) {
			if (char === quote) quote = undefined;
			else token += char;
			continue;
		}
		if (char === "'" || char === '"') { quote = char; continue; }
		if (/\s/.test(char)) {
			if (token) { tokens.push(token); token = ""; }
		} else token += char;
	}
	if (escaped) token += "\\";
	if (quote) return [];
	if (token) tokens.push(token);
	return tokens;
}

/** Unknown checklist markers, including removed [file]/[match], are advisory. */
export function parseAssertion(raw: string): ContractAssertion {
	const advisory: ContractAssertion = { kind: "advisory", raw, text: raw.replace(/^advisory\s*[:\-]\s*/i, "").trim() };
	const marker = raw.match(/^\[cmd\]\s+(.+)$/i);
	if (!marker) return advisory;
	const tokens = tokenizeCommand(commandText(marker[1]));
	const [command, ...args] = tokens;
	return command ? { kind: "cmd", raw, command, args } : advisory;
}

export function isMandatory(assertion: ContractAssertion): boolean {
	return assertion.kind === "cmd";
}

export function extractContractAssertions(markdown: string, headings: string[]): ContractAssertion[] {
	for (const heading of headings) {
		const body = extractSection(markdown, heading);
		if (!body) continue;
		const items = parseListItems(body);
		if (items.length > 0) return items.map(parseAssertion);
	}
	return [];
}

function buildContract(markdown: string, source: AcceptanceContract["source"], headings: string[], contractPath?: string): AcceptanceContract {
	const assertions = extractContractAssertions(markdown, headings);
	const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || markdown.split("\n").find(line => line.trim())?.trim() || "untitled";
	return {
		version: 3,
		source,
		objective: sectionText(markdown, ["Objective"]) || title,
		scope: sectionText(markdown, ["Scope"]),
		acceptanceCriteria: sectionText(markdown, ["Acceptance Criteria", "Requirements"]),
		evidenceRequirements: sectionText(markdown, ["Evidence Requirements", "Evidence"]),
		constraints: sectionText(markdown, ["Constraints"]),
		contractPath: contractPath ? resolve(contractPath) : undefined,
		assertions,
		mandatory: assertions.filter(isMandatory),
		fingerprint: planFingerprint(markdown),
	};
}

export function emptyContract(markdown: string, source: AcceptanceContract["source"], contractPath?: string): AcceptanceContract {
	return { version: 3, source, objective: markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || "untitled", scope: "", acceptanceCriteria: "", evidenceRequirements: "", constraints: "", contractPath: contractPath ? resolve(contractPath) : undefined, assertions: [], mandatory: [], fingerprint: planFingerprint(markdown) };
}

export function bindAcceptanceContract(markdown: string, source: "plan" | "pipeline", contractPath?: string): AcceptanceContract {
	return buildContract(markdown, source, ["Verification Commands", "Contract", "Verification"], contractPath);
}

export function bindSpecContract(markdown: string, contractPath?: string): AcceptanceContract {
	return buildContract(markdown, "spec", ["Verification Commands", "Contract", "Requirements", "Acceptance Criteria"], contractPath);
}
