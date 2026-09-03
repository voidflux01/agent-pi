// ABOUTME: Explainability and adequacy checks for executable acceptance contracts.
// ABOUTME: These checks prevent structural-only or no-test contracts from looking complete.

import type { AcceptanceContract } from "./execution-contract.ts";

export interface ContractQuality {
	status: "PASS" | "BLOCKED";
	findings: string[];
}

const behaviorCommand = /(?:test|check|verify|lint|build|compile|pytest|jest|vitest|mocha|phpunit|go\s+test|cargo\s+test|dotnet\s+test|mvn|mvnd|gradle)/i;
const noTestSuccess = /(?:failIfNoSpecifiedTests\s*=\s*false|skipTests|maven\.test\.skip\s*=\s*true|passWithNoTests|no[- ]tests|\|\|\s*true)/i;

export function inspectContractQuality(contract: AcceptanceContract): ContractQuality {
	const findings: string[] = [];
	const commands = contract.mandatory.filter((assertion) => assertion.kind === "cmd");

	if (commands.length === 0) findings.push("没有 [cmd] 行为验证，无法进行确定性验收。");
	if (commands.length > 0 && !commands.some((assertion) => assertion.kind === "cmd" && behaviorCommand.test([assertion.command, ...assertion.args].join(" ")))) {
		findings.push("[cmd] 未包含可识别的测试、构建、检查或验证动作，行为覆盖不足。");
	}
	for (const assertion of commands) {
		const command = [assertion.command, ...assertion.args].join(" ");
		if (noTestSuccess.test(command)) findings.push(`[cmd] 允许无测试成功或跳过测试：${assertion.raw}`);
	}
	if (!contract.objective.trim()) findings.push("缺少任务目标（Objective）。");
	if (!contract.scope.trim()) findings.push("缺少验收范围（Scope）。");
	if (!contract.acceptanceCriteria.trim()) findings.push("缺少验收条件（Acceptance Criteria）。");
	if (!contract.evidenceRequirements.trim()) findings.push("缺少证据要求（Evidence Requirements）。");

	return { status: findings.length === 0 ? "PASS" : "BLOCKED", findings };
}
