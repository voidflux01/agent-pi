// ABOUTME: Acceptance checklist extracted from approved plan markdown or pipeline $PLAN.
// ABOUTME: Identity is a SHA-256 of the full source text, matching planApprovalBinding fingerprints.

import { createHash } from "node:crypto";

export type VerificationStatus = "PASS" | "FAIL" | "BLOCKED";

export interface AcceptanceContract {
	version: 1;
	source: "plan" | "pipeline";
	objective: string;
	criteria: string[];
	fingerprint: string;
	requiresTests: boolean;
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

export function extractAcceptanceCriteria(markdown: string): { criteria: string[]; section: "Contract" | "Verification" | null } {
	const contractItems = parseListItems(extractSection(markdown, "Contract") || "");
	if (contractItems.length > 0) return { criteria: contractItems, section: "Contract" };
	const verificationItems = parseListItems(extractSection(markdown, "Verification") || "");
	if (verificationItems.length > 0) return { criteria: verificationItems, section: "Verification" };
	return { criteria: [], section: null };
}

export function criteriaRequireTests(criteria: string[]): boolean {
	return criteria.some(item => /\btests?\b/i.test(item));
}

export function bindAcceptanceContract(
	markdown: string,
	source: "plan" | "pipeline",
): AcceptanceContract | { error: "incomplete" } {
	const { criteria } = extractAcceptanceCriteria(markdown);
	if (criteria.length === 0) return { error: "incomplete" };
	const objective = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim()
		|| markdown.split("\n").find(line => line.trim())?.trim()
		|| "untitled";
	return {
		version: 1,
		source,
		objective,
		criteria,
		fingerprint: planFingerprint(markdown),
		requiresTests: criteriaRequireTests(criteria),
	};
}

/** Keep a previously bound planner checklist when the new text has no Contract/Verification items. */
export function retainBoundChecklist(previousText: string, candidate: string): string {
	const next = bindAcceptanceContract(candidate, "pipeline");
	if (!("error" in next)) return candidate;
	if (previousText && !("error" in bindAcceptanceContract(previousText, "pipeline"))) return previousText;
	return candidate || previousText;
}

export function resolveAcceptanceContract(
	candidate: string,
	source: "plan" | "pipeline",
	previous?: AcceptanceContract,
): AcceptanceContract | { error: "incomplete" } {
	const next = bindAcceptanceContract(candidate, source);
	if (!("error" in next)) return next;
	if (previous && previous.criteria.length > 0) return previous;
	return { error: "incomplete" };
}

/** @deprecated Prefer planFingerprint of the approved source text. Kept for hash helpers in tests. */
export function objectiveHash(material: { objective: string; successCriteria: string[] }): string {
	return planFingerprint(`${material.objective.trim()}\n${[...material.successCriteria].map(v => v.trim()).sort().join("\n")}`);
}
