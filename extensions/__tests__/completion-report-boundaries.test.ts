import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { execGit, verifierRiskSummary } from "../completion-report.ts";
import type { VerifierReceipt } from "../lib/verifier-runtime.ts";

function receipt(overrides: Partial<NonNullable<VerifierReceipt["verifier"]>["report"]>): VerifierReceipt {
	const report = {
		status: "PASS",
		summary: "ok",
		requirements: [{ requirement: "r", status: "PASS", evidence: "e" }],
		contract: { status: "PASS", findings: [] },
		review: { status: "PASS", findings: [] },
		behavior: { status: "PASS", findings: [], tests: { discovered: 1, executed: 1, failed: 0, skipped: 0 } },
		quality: { status: "PASS", findings: [] },
		security: { status: "PASS", findings: [] },
		hard_blockers: [],
		warnings: [],
		...overrides,
	};
	return { verifier: { runId: "v", status: report.status as never, summary: report.summary, report } } as unknown as VerifierReceipt;
}

describe("completion report boundaries", () => {
	it("passes git input as argument arrays", () => {
		const source = readFileSync(new URL("../completion-report.ts", import.meta.url), "utf8");
		expect(source).toContain("execFileSync(\"git\", args");
		expect(source).toContain("MAX_COMPLETION_REQUEST_BODY_BYTES = 256 * 1024");
		expect(source).toContain("readRequestBody(req, res");
		expect(source).not.toContain('req.on("data", (chunk) => { body += chunk; });');
		expect(source).not.toContain("execSync(");
		expect(execGit(["rev-parse", "--is-inside-work-tree"], process.cwd())).toBe("true");
	});

	it("restricts rollback to files in the displayed report", () => {
		const source = readFileSync(new URL("../completion-report.ts", import.meta.url), "utf8");
		expect(source).toContain("File is not part of this report");
		expect(source).toContain("--end-of-options");
	});

	it("returns a structured completion blocker for non-Git workspaces", () => {
		const source = readFileSync(new URL("../completion-report.ts", import.meta.url), "utf8");
		expect(source).toContain("completionBlocked: true");
		expect(source).toContain("not a Git repository");
		expect(source).toContain("Do not output done:true");
	});

	it("runs autonomous verification only for bound contracts", () => {
		const source = readFileSync(new URL("../completion-report.ts", import.meta.url), "utf8");
		expect(source).toContain("runAutonomousCompletion");
		expect(source).toContain("contract or task");
		expect(source).toContain("no acceptance contract or non-empty task");
		expect(source).toContain('mode === "PLAN"');
		expect(source).toContain('mode === "SPEC"');
	});

	it("surfaces verifier non-PASS status and warnings as risk to the reviewer", () => {
		const reportSource = readFileSync(new URL("../completion-report.ts", import.meta.url), "utf8");
		const htmlSource = readFileSync(new URL("../lib/completion-report-html.ts", import.meta.url), "utf8");
		// Viewer wires verifier risk from the receipt into the report payload.
		expect(reportSource).toContain("report.verifier = verifierRisks");
		expect(reportSource).toContain("hard_blockers");
		expect(reportSource).toContain("Verifier risk:");
		// HTML renders the banner with a distinct warning/fail treatment.
		expect(htmlSource).toContain('id="verifierBanner"');
		expect(htmlSource).toContain(".verifier-banner.fail");
		expect(htmlSource).toContain("Verifier did not PASS");
		expect(htmlSource).toContain("Verifier passed with warnings");
	});
});

describe("verifier risk summary", () => {
	it("stays silent on a clean PASS", () => {
		expect(verifierRiskSummary(receipt({}))).toBeUndefined();
	});

	it("flags explicit warnings", () => {
		const out = verifierRiskSummary(receipt({ warnings: ["flaky suite; rerun flaky:true"] }))!;
		expect(out.status).toBe("PASS");
		expect(out.risks).toEqual(["flaky suite; rerun flaky:true"]);
	});

	it("flags section verdicts (WARN quality) with their findings", () => {
		const out = verifierRiskSummary(receipt({ quality: { status: "WARN", findings: ["duplicated init logic in 3 modules"] } }))!;
		expect(out.status).toBe("PASS");
		expect(out.risks).toContain("[quality] duplicated init logic in 3 modules");
	});

	it("flags material review findings but not LOW severity", () => {
		const out = verifierRiskSummary(receipt({
			review: {
				status: "PASS", findings: [
					{ severity: "MEDIUM", title: "unbounded retry", location: "lib/x.ts:12" },
					{ severity: "LOW", title: "naming nit" },
				]
			},
		}))!;
		expect(out.risks).toContain("[MEDIUM] unbounded retry @ lib/x.ts:12");
		expect(out.risks.some((r) => r.includes("naming nit"))).toBe(false);
	});

	it("flags requirements the verifier could not clear", () => {
		const out = verifierRiskSummary(receipt({
			requirements: [{ requirement: "handles empty input", status: "FAIL", evidence: "throws on []" }],
		}))!;
		expect(out.risks).toContain("[requirement FAIL] handles empty input — throws on []");
	});

	it("flags failed tests", () => {
		const out = verifierRiskSummary(receipt({ behavior: { status: "PASS", findings: [], tests: { discovered: 4, executed: 4, failed: 1, skipped: 0 } } }))!;
		expect(out.risks).toContain("[behavior] 1 test(s) failed");
	});

	it("flags an overall non-PASS that completed via override, deduping repeats", () => {
		const out = verifierRiskSummary(receipt({ status: "BLOCKED", hard_blockers: ["setup missing", "setup missing"] }))!;
		expect(out.status).toBe("BLOCKED");
		expect(out.risks).toEqual(["[blocker] setup missing"]);
	});
});
