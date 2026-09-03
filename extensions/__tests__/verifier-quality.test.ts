import { describe, expect, it } from "vitest";
import { bindAcceptanceContract } from "../lib/execution-contract.ts";
import { inspectContractQuality } from "../lib/verifier-quality.ts";
import { buildVerifierPrompt, parseVerifierReport } from "../lib/verifier-subagent.ts";
import { readFileSync } from "node:fs";

function contract(text: string) {
	const result = bindAcceptanceContract(text, "plan");
	if ("error" in result) throw new Error("expected contract");
	return result;
}

const validVerifierResult = `## VERIFIER RESULT
{"status":"PASS","summary":"clean","requirements":[],"contract":{"status":"PASS","findings":[]},"behavior":{"status":"PASS","findings":[],"tests":{"discovered":1,"executed":1,"failed":0,"skipped":0}},"quality":{"status":"PASS","findings":[]},"security":{"status":"PASS","findings":[]},"hard_blockers":[],"warnings":[]}
## END`;

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
		expect(prompt).toContain("read-only verification commands");
		const source = readFileSync(new URL("../lib/verifier-subagent.ts", import.meta.url), "utf8");
		expect(source).toContain('AGENT_PI_CONFIG.workers.thinking');
		expect(source).toContain('"--tools", "read,bash,grep,find,ls"');
		expect(source).toContain('herdrDoneExtPath = join(dirname(extDir), "herdr-done.ts")');
		expect(source).toContain('herdrLabel: "VERIFIER"');
	});

	it("passes deterministic evidence to the verifier and forbids stranded statuses", () => {
		const prompt = buildVerifierPrompt(contract(`# Plan: x\n\n## Contract\n- [cmd] mvnd -q test\n`), false, "1. [cmd] mvnd -q test => pass");
		expect(prompt).toContain("deterministic evidence runner has already executed");
		expect(prompt).toContain("never invent UNVERIFIED");
	});

	it("accepts a valid result followed by trailing assistant text", () => {
		expect(parseVerifierReport(`${validVerifierResult}\n验收完成。`)).toMatchObject({ status: "PASS", summary: "clean" });
	});

	it("uses the last valid result when an earlier block is malformed", () => {
		expect(parseVerifierReport(`## VERIFIER RESULT\nnot json\n## END\n\n${validVerifierResult}`)?.status).toBe("PASS");
	});

	it("normalizes legacy UNVERIFIED and accepts the verbose end marker", () => {
		const json = validVerifierResult
			.replace(/^## VERIFIER RESULT\n/, "")
			.replace(/\n## END$/, "")
			.replace('"status":"PASS"', '"status":"UNVERIFIED"');
		const legacy = `## VERIFIER RESULT\n\`\`\`json\n${json}\n\`\`\`\n## END VERIFIER RESULT`;
		const report = parseVerifierReport(legacy);
		expect(report?.status).toBe("BLOCKED");
	});

	it("normalizes the legacy static-audit payload instead of reporting no result", () => {
		const legacy = `## VERIFIER RESULT
\`\`\`json
{"status":"UNVERIFIED","verdict":"STATIC-ALL-PASS-CMD-NOT-RUN","reason":"cargo test NOT EXECUTED","checks":[{"assertion":"[cmd] cargo test","result":"NOT_RUN","evidence":"no shell"}]}
\`\`\`
## END VERIFIER RESULT`;
		const report = parseVerifierReport(legacy);
		expect(report).toMatchObject({ status: "BLOCKED", summary: "cargo test NOT EXECUTED" });
		expect(report?.hard_blockers).toContain("cargo test NOT EXECUTED");
	});
});
