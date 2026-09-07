import { extractResultBlock } from "./agent-result-contract.ts";

export type ReviewerDecision = "APPROVED" | "NEEDS CHANGES" | "UNKNOWN";

/** Fail closed: only an explicit reviewer approval may unlock REVIEW. */
export function reviewerDecision(output: string): ReviewerDecision {
	const block = extractResultBlock(output).result;
	if (!block) return "UNKNOWN";
	const decision = block.match(/^(?:summary|decision):\s*(.+)$/im)?.[1]?.trim() || "";
	if (/\bNEEDS\s+CHANGES\b/i.test(decision)) return "NEEDS CHANGES";
	if (/\bAPPROVED\b/i.test(decision)) return "APPROVED";
	return "UNKNOWN";
}
