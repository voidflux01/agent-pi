import { extractResultBlock } from "./agent-result-contract.ts";

export type ReviewerDecision = "APPROVED" | "NEEDS CHANGES" | "UNKNOWN";

/** Fail closed: only an explicit reviewer approval may unlock REVIEW. */
export function reviewerDecision(output: string): ReviewerDecision {
	const block = extractResultBlock(output).result;
	if (!block) return "UNKNOWN";
	// Tolerant of formatting: scan the whole RESULT block, not just the first
	// summary/decision line (models routinely bury the verdict in prose). The
	// gate stays semantic: NEEDS CHANGES / negations win, and a block that
	// never literally says APPROVED is UNKNOWN (dogfood D13-real).
	if (/\bNEEDS\s+CHANGES\b/i.test(block) || /\bnot\s+approved\b/i.test(block) || /\bNOT\s+APPROVED\b/i.test(block) || /\bdeclined\b/i.test(block)) return "NEEDS CHANGES";
	if (/\bAPPROVED\b/i.test(block)) return "APPROVED";
	return "UNKNOWN";
}
