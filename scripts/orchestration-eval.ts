// ABOUTME: Provider-free runtime evaluation for orchestration scheduling.
// ABOUTME: Measures actual synthetic wall time while keeping model/token claims
// ABOUTME: out of the result; provider-backed mode runs remain a separate gate.

import { createOrchestrationRun } from "../extensions/lib/orchestration-run.ts";
import { scheduleResourceWaves, type ResourceScheduledJob } from "../extensions/lib/resource-scheduler.ts";

interface EvalJob extends ResourceScheduledJob {
	name: string;
	durationMs: number;
}

interface ScenarioResult {
	name: string;
	trials: number;
	baselineMs: number;
	 scheduledMs: number;
	waves: number[][];
	speedup: number;
	status: "PASS" | "FAIL";
}

const TRIALS = 3;
const JOBS: EvalJob[] = [
	{ name: "scout", durationMs: 24 },
	{ name: "researcher", durationMs: 24 },
	{ name: "reviewer", durationMs: 24 },
];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function runSequential(jobs: EvalJob[]): Promise<number> {
	const started = performance.now();
	for (const job of jobs) await sleep(job.durationMs);
	return performance.now() - started;
}

async function runWaves(jobs: EvalJob[], maxParallel: number): Promise<{ elapsedMs: number; waves: number[][] }> {
	const waves = scheduleResourceWaves(jobs, maxParallel);
	const started = performance.now();
	for (const wave of waves) await Promise.all(wave.map((index) => sleep(jobs[index].durationMs)));
	return { elapsedMs: performance.now() - started, waves };
}

async function evaluateScenario(name: string, jobs: EvalJob[]): Promise<ScenarioResult> {
	let baseline = 0;
	let scheduled = 0;
	let waves: number[][] = [];
	for (let trial = 0; trial < TRIALS; trial += 1) {
		baseline += await runSequential(jobs);
		const result = await runWaves(jobs, jobs.length);
		scheduled += result.elapsedMs;
		waves = result.waves;
	}
	const baselineMs = Math.round(baseline / TRIALS);
	const scheduledMs = Math.round(scheduled / TRIALS);
	return {
		name,
		trials: TRIALS,
		baselineMs,
		scheduledMs,
		waves,
		speedup: Number((baseline / Math.max(1, scheduled)).toFixed(2)),
		status: scheduled < baseline ? "PASS" : "FAIL",
	};
}

async function main(): Promise<void> {
	const independent = await evaluateScenario("independent-parallel", JOBS);
	const conflicting = await evaluateScenario("resource-conflict-waves", [
		{ name: "writer-a", durationMs: 24, resources: ["src/app.ts"] },
		{ name: "writer-b", durationMs: 24, resources: ["src/app.ts"] },
		{ name: "docs", durationMs: 24, resources: ["docs"] },
	]);
	const budgetRun = createOrchestrationRun({ budget: { maxSteps: 1, maxTokens: 100, maxCostUsd: 1 }, actor: "orchestration-eval" });
	const withinBudgetCancellation = budgetRun.recordUsage({ totalTokens: 101, costUsd: 0.01 }) === false && budgetRun.signal.aborted;
	budgetRun.finish("cancelled", { synthetic: true });
	const budget = { name: "budget-cancellation", status: withinBudgetCancellation ? "PASS" : "FAIL" };
	const result = {
		kind: "provider-free-orchestration-eval",
		generatedAt: new Date().toISOString(),
		limitations: ["Synthetic worker durations only", "No provider token/cost or mode success claims"],
		scenarios: [independent, conflicting],
		budget,
		status: [independent.status, conflicting.status, budget.status].every((status) => status === "PASS") ? "PASS" : "FAIL",
	};
	if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
	else {
		console.log(`Provider-free orchestration eval: ${result.status}`);
		for (const scenario of result.scenarios) console.log(`- ${scenario.name}: ${scenario.status}, ${scenario.baselineMs}ms → ${scenario.scheduledMs}ms, ${scenario.speedup}x, waves=${JSON.stringify(scenario.waves)}`);
		console.log(`- ${budget.name}: ${budget.status}`);
		console.log(`Limitations: ${result.limitations.join("; ")}`);
	}
	if (result.status !== "PASS") process.exitCode = 1;
}

await main();
