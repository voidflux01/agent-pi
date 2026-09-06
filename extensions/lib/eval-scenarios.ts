// ABOUTME: Provider-free functional and workflow regression sets exercise real plugin policies.
import { evaluateCase, calibrateJudge, parseEvalCase, type EvalCase, type JudgeAdapter } from "./eval-engine.ts";
import { scheduleResourceWaves } from "./resource-scheduler.ts";
import { workflowDirection } from "./workflow-direction.ts";
import { canComplete } from "./verifier-runtime.ts";
import { createOrchestrationRun } from "./orchestration-run.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const EVALS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../evals");
const EVAL_FILES = ["functional-budget-and-scheduling.yaml", "workflow-failure-and-stale-receipt.yaml"];

export const regressionCases: EvalCase[] = EVAL_FILES.map((file) => {
	const raw = YAML.parse(readFileSync(join(EVALS_DIR, file), "utf8"));
	return parseEvalCase(raw);
});

export async function runRegressionEvals(signal?: AbortSignal) {
	const reports = [];
	for (const c of regressionCases) reports.push(await evaluateCase(c, async () => {
		let pass = false;
		if (c.kind === "functional") {
			const waves = scheduleResourceWaves([{ resources: ["src/a"] }, { resources: ["src/a"] }, { resources: ["docs"] }], 3);
			const run = createOrchestrationRun({ actor: "eval-fixture", budget: { maxTokens: 1 } });
			pass = !run.recordUsage({ totalTokens: 2 }) && run.signal.aborted && waves.length === 2 && !waves.some(w => w.includes(0) && w.includes(1));
			run.finish("failed");
		} else {
			const receipt = { version: 3, status: "PASS", contractFingerprint: "contract", workspaceManifestHash: "old", results: [{ status: "pass" }], attempt: 1, createdAt: "" };
			pass = workflowDirection({ status: "FAIL", failure: "implementation" }).next === "BUILD"
				&& workflowDirection({ status: "FAIL", failure: "assumption" }).next === "PLAN"
				&& workflowDirection({ status: "FAIL", attempt: 3 }).next === "ASK_USER"
				&& !canComplete(receipt as any, { fingerprint: "contract" } as any, "new");
		}
		return { output: pass ? c.kind === "functional" ? "BUDGET_AND_CONFLICT_PASS" : "RECOVERY_AND_STALE_PASS" : "REGRESSION_FAILED", exitCode: pass ? 0 : 1, model: "provider-free", tokens: 0 };
	}, { signal }));
	return reports;
}

/** A deterministic test double validates the calibration harness, not an LLM's reliability. */
export const calibrationFixture: JudgeAdapter = {
	model: "fixture-only-not-an-llm",
	async evaluate(_rubric, evidence) { return { tokens: 0, verdict: { score: evidence[0].text.startsWith("observed_exit=0") ? 5 : 1, reason: "Observed exit code", evidence_refs: [evidence[0].id] } }; },
};
export function runCalibrationFixture(signal: AbortSignal) { return calibrateJudge(calibrationFixture, signal); }
