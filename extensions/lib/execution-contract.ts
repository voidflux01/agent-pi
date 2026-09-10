// ABOUTME: Acceptance contract carries an objective plus optional historical evidence markers.
// ABOUTME: Completion is decided by the independent verifier's explainable Objective review.

import { createHash } from "node:crypto";
import { resolve } from "node:path";

export type VerificationStatus = "PASS" | "FAIL" | "BLOCKED";
export type ContractAssertion =
	| { kind: "eval"; raw: string; path: string; sha256: string }
	| { kind: "advisory"; raw: string; text: string };

export interface RequiredEvalBinding {
	/** Workspace-relative path of the eval set the user made mandatory. */
	path: string;
	/** Content hash the eval report must match; the set is bound by version + content. */
	sha256: string;
}

export interface AcceptanceContract {
	version: 3;
	source: "plan" | "pipeline" | "spec" | "task";
	objective: string;
	scope: string;
	acceptanceCriteria: string;
	evidenceRequirements: string;
	constraints: string;
	/** Exact approved Markdown file used as the contract source, when file-backed. */
	contractPath?: string;
	assertions: ContractAssertion[];
	/** Present when the confirmed contract binds a mandatory eval set via [eval]. */
	requiredEval?: RequiredEvalBinding;
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
export function tokenizeCommand(input: string): string[] {
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

/** Removed markers ([cmd]/[file]/[match]) and natural-language items are advisory. */
export function parseAssertion(raw: string): ContractAssertion {
	const advisory: ContractAssertion = { kind: "advisory", raw, text: raw.replace(/^advisory\s*[:\-]\s*/i, "").trim() };
	const evalMarker = raw.match(/^\[eval\]\s+(.+)$/i);
	if (evalMarker) {
		const [path, hash] = tokenizeCommand(commandText(evalMarker[1]));
		const hashValue = hash?.match(/^sha256:([0-9a-f]{64})$/i)?.[1];
		return path && hashValue && !path.includes("..") && !path.startsWith("/")
			? { kind: "eval", raw, path, sha256: hashValue.toLowerCase() }
			: advisory;
	}
	return advisory;
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
		/** Set when the user marked an eval set as a mandatory acceptance item via [eval]. */
		requiredEval: assertions.find((a): a is Extract<ContractAssertion, { kind: "eval" }> => a.kind === "eval"),
		fingerprint: planFingerprint(markdown),
	};
}

export function emptyContract(markdown: string, source: AcceptanceContract["source"], contractPath?: string): AcceptanceContract {
	return { version: 3, source, objective: markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || "untitled", scope: "", acceptanceCriteria: "", evidenceRequirements: "", constraints: "", contractPath: contractPath ? resolve(contractPath) : undefined, assertions: [], fingerprint: planFingerprint(markdown) };
}

export function bindAcceptanceContract(markdown: string, source: "plan" | "pipeline" | "task", contractPath?: string): AcceptanceContract {
	return buildContract(markdown, source, ["Verification Commands", "Contract", "Verification"], contractPath);
}

export function bindSpecContract(markdown: string, contractPath?: string): AcceptanceContract {
	return buildContract(markdown, "spec", ["Verification Commands", "Contract", "Requirements", "Acceptance Criteria"], contractPath);
}
