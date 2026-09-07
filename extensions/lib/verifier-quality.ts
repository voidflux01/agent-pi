// ABOUTME: Explainability checks for Objective-based acceptance contracts.
// ABOUTME: These checks prevent an empty or un-auditable Objective from looking complete.

import type { AcceptanceContract } from "./execution-contract.ts";

export interface ContractQuality {
	status: "PASS" | "BLOCKED";
	findings: string[];
}

export function inspectContractQuality(contract: AcceptanceContract): ContractQuality {
	const findings: string[] = [];
	if (!contract.objective.trim()) findings.push("缺少任务目标（Objective）。");
	return { status: findings.length === 0 ? "PASS" : "BLOCKED", findings };
}
