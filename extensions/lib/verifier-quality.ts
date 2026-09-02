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
	const structural = contract.mandatory.filter((assertion) => assertion.kind === "file" || assertion.kind === "match");

	if (commands.length === 0) findings.push("没有 [cmd] 行为验证，只能证明文件或字符串存在，无法证明需求完成。");
	if (commands.length > 0 && !commands.some((assertion) => assertion.kind === "cmd" && behaviorCommand.test([assertion.command, ...assertion.args].join(" ")))) {
		findings.push("[cmd] 未包含可识别的测试、构建、检查或验证动作，行为覆盖不足。");
	}
	for (const assertion of commands) {
		const command = [assertion.command, ...assertion.args].join(" ");
		if (noTestSuccess.test(command)) findings.push(`[cmd] 允许无测试成功或跳过测试：${assertion.raw}`);
	}
	if (structural.length > 0 && commands.length === 0) findings.push("当前契约是结构门禁，不是可解释的验收门禁。");

	return { status: findings.length === 0 ? "PASS" : "BLOCKED", findings };
}
