import { describe, expect, it } from "vitest";
import { bindAcceptanceContract } from "../lib/execution-contract.ts";
import { inspectContractQuality } from "../lib/verifier-quality.ts";
import { buildVerifierPrompt } from "../lib/verifier-subagent.ts";

function contract(text: string) {
	const result = bindAcceptanceContract(text, "plan");
	if ("error" in result) throw new Error("expected contract");
	return result;
}

describe("acceptance contract quality", () => {
	it("blocks structural-only contracts", () => {
		const result = inspectContractQuality(contract(`# Plan: x\n\n## Contract\n- [file] src/x.ts\n- [match] class X :: src/x.ts\n`));
		expect(result.status).toBe("BLOCKED");
		expect(result.findings.join(" ")).toMatch(/行为验证|结构门禁/);
	});

	it("blocks commands that succeed when no tests are discovered", () => {
		const result = inspectContractQuality(contract(`# Plan: x\n\n## Contract\n- [cmd] mvn -q test -Dtest=X -Dsurefire.failIfNoSpecifiedTests=false\n`));
		expect(result.status).toBe("BLOCKED");
		expect(result.findings.join(" ")).toContain("无测试成功");
	});

	it("accepts a representative test command", () => {
		const result = inspectContractQuality(contract(`# Plan: x\n\n## Contract\n- [cmd] mvnd -q test\n- [match] toggleTodo :: src/todos.js\n`));
		expect(result.status).toBe("PASS");
	});

	it("keeps verifier skills enabled and its audit prompt read-only", () => {
		const prompt = buildVerifierPrompt(contract(`# Plan: x\n\n## Contract\n- [cmd] mvnd -q test\n`));
		expect(prompt).toContain("Skills are enabled and must remain available");
		expect(prompt).toContain("must not modify any file");
	});
});
