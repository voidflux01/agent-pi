// ABOUTME: Versioned evaluation contracts; deterministic checks and optional judges stay separate from acceptance receipts.
import { randomUUID } from "node:crypto";
import { digest, redactEvidence } from "./workflow-artifacts.ts";

export type EvalStatus = "PASS" | "FAIL" | "BLOCKED" | "INCONCLUSIVE";
export type EvalExecutor = "provider-free" | "command" | "pi-workflow";
export interface EvalCase {
	id: string; version: number; kind: "functional" | "behavioral" | "security" | "workflow";
	task: string; timeout_ms: number; max_tokens: number;
	/** User eval sets must declare an executor; bundled regression cases omit it. */
	executor?: EvalExecutor;
	/** Required for executor "command": a single shell-like command, tokenized without a shell. */
	command?: string;
	expect: Array<{ type: "contains"; value: string } | { type: "exit"; code: number } | { type: "judge"; rubric: string; rubric_version: number; threshold: number }>;
}
export interface EvaluationEvidence { id: string; sha256: string; text: string; source: string; }
export interface EvalExecution { output: string; exitCode: number | null; tokens?: number; model?: string; blocked?: string; incomplete?: string; }
export interface JudgeVerdict { score: number; reason: string; evidence_refs: string[]; }
export interface JudgeAdapter { model: string; evaluate: (rubric: string, evidence: EvaluationEvidence[], signal: AbortSignal, maxTokens: number) => Promise<{ verdict: unknown; tokens?: number }> }
export interface EvalReport {
	schema_version: 1; run_id: string; case_id: string; case_version: number; kind: string; created_at: string;
	status: EvalStatus; elapsed_ms: number; model: string; judge_model?: string; tokens: number | null;
	/** Present on user eval-set runs; builtin regression cases omit it. */
	executor?: string; eval_set?: string; eval_set_sha256?: string;
	budget: { timeout_ms: number; max_tokens: number }; evidence: EvaluationEvidence[];
	checks: Array<{ status: EvalStatus; reason: string; rubric_version?: number; verdict?: JudgeVerdict }>;
	completionAllowed: false;
}

export function parseEvalCase(raw: unknown): EvalCase {
	const c = raw as EvalCase;
	if (!c || typeof c !== "object" || !/^[a-z0-9-]{1,80}$/.test(c.id) || !Number.isInteger(c.version) || c.version < 1
		|| !["functional", "behavioral", "security", "workflow"].includes(c.kind) || typeof c.task !== "string" || !c.task.trim() || c.task.length > 16000
		|| !Number.isInteger(c.timeout_ms) || c.timeout_ms < 10 || c.timeout_ms > 900000
		|| !Number.isInteger(c.max_tokens) || c.max_tokens < 1 || c.max_tokens > 100000
		|| !Array.isArray(c.expect) || c.expect.length < 1 || c.expect.length > 30) throw new Error("Invalid eval case");
	if (c.executor !== undefined && !["provider-free", "command", "pi-workflow"].includes(c.executor)) throw new Error("Invalid eval executor");
	if (c.executor === "command" && (typeof c.command !== "string" || !c.command.trim() || c.command.length > 2000)) throw new Error("Command executor requires a bounded command string");
	if (c.executor === undefined && c.command !== undefined) throw new Error("Eval command requires an executor");
	for (const e of c.expect) {
		if (!e || typeof e !== "object") throw new Error("Invalid expectation");
		if (e.type === "contains" && typeof e.value === "string" && e.value.length > 0 && e.value.length <= 4000) continue;
		if (e.type === "exit" && Number.isInteger(e.code) && e.code >= 0 && e.code <= 255) continue;
		if (e.type === "judge" && typeof e.rubric === "string" && e.rubric.length > 0 && e.rubric.length <= 4000
			&& Number.isInteger(e.rubric_version) && e.rubric_version >= 1 && Number.isInteger(e.threshold) && e.threshold >= 1 && e.threshold <= 5) continue;
		throw new Error("Invalid expectation");
	}
	return c;
}

export function parseJudgeVerdict(raw: unknown, refs: string[]): JudgeVerdict {
	const v = typeof raw === "string" ? JSON.parse(raw) : raw as any;
	if (!v || !Number.isInteger(v.score) || v.score < 1 || v.score > 5 || typeof v.reason !== "string" || !v.reason.trim() || v.reason.length > 4000
		|| !Array.isArray(v.evidence_refs) || v.evidence_refs.length < 1 || v.evidence_refs.length > 20
		|| !v.evidence_refs.every((r: unknown) => typeof r === "string" && refs.includes(r))) throw new Error("Judge must cite existing evidence and return score 1–5");
	return { score: v.score, reason: redactEvidence(v.reason), evidence_refs: v.evidence_refs };
}

export function aggregateEvalStatus(statuses: EvalStatus[]): EvalStatus {
	if (!statuses.length) return "INCONCLUSIVE";
	return statuses.includes("FAIL") ? "FAIL" : statuses.includes("BLOCKED") ? "BLOCKED" : statuses.includes("INCONCLUSIVE") ? "INCONCLUSIVE" : "PASS";
}

async function bounded<T>(action: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw new Error("Evaluation cancelled or timed out");
	let abort: () => void = () => {};
	try {
		return await Promise.race([action(signal), new Promise<never>((_resolve, reject) => {
			abort = () => reject(new Error("Evaluation cancelled or timed out")); signal.addEventListener("abort", abort, { once: true });
		})]);
	} finally { signal.removeEventListener("abort", abort); }
}

export async function evaluateCase(raw: unknown, execute: (signal: AbortSignal) => Promise<EvalExecution>, options: { judge?: JudgeAdapter; signal?: AbortSignal } = {}): Promise<EvalReport> {
	const c = parseEvalCase(raw), started = Date.now(), controller = new AbortController();
	const abort = () => controller.abort();
	if (options.signal?.aborted) controller.abort();
	else options.signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(abort, c.timeout_ms);
	const report: EvalReport = { schema_version: 1, run_id: randomUUID(), case_id: c.id, case_version: c.version, kind: c.kind,
		created_at: new Date().toISOString(), status: "INCONCLUSIVE", elapsed_ms: 0, model: "unavailable", tokens: null,
		budget: { timeout_ms: c.timeout_ms, max_tokens: c.max_tokens }, evidence: [], checks: [], completionAllowed: false,
		...(options.judge ? { judge_model: options.judge.model } : {}) };
	try {
		const result = await bounded(execute, controller.signal);
		report.model = result.model || "provider-free";
		if (result.tokens !== undefined && (!Number.isFinite(result.tokens) || result.tokens < 0)) throw new Error("Invalid token accounting");
		report.tokens = result.tokens ?? null;
		if (result.blocked) report.checks.push({ status: "BLOCKED", reason: redactEvidence(result.blocked) });
		else if (result.incomplete) report.checks.push({ status: "INCONCLUSIVE", reason: redactEvidence(result.incomplete) });
		else {
			if (Buffer.byteLength(result.output) > 64000) throw new Error("Evidence exceeds size limit");
			const evidence = { id: "execution-output", sha256: digest(result.output), text: redactEvidence(result.output), source: "runner-observed output; untrusted" };
			report.evidence.push(evidence);
			if (result.exitCode !== 0) report.checks.push({ status: "FAIL", reason: `Execution exit: ${result.exitCode}` });
			if ((report.tokens ?? 0) > c.max_tokens) report.checks.push({ status: "FAIL", reason: "Token budget exceeded" });
			for (const expectation of c.expect) {
				if (controller.signal.aborted) throw new Error("Evaluation cancelled or timed out");
				if (expectation.type === "exit") report.checks.push({ status: result.exitCode === expectation.code ? "PASS" : "FAIL", reason: `Expected exit ${expectation.code}; observed ${result.exitCode}` });
				if (expectation.type === "contains") report.checks.push({ status: result.output.includes(expectation.value) ? "PASS" : "FAIL", reason: `Expected output marker: ${redactEvidence(expectation.value)}` });
				if (expectation.type === "judge") {
					if (!options.judge) { report.checks.push({ status: "INCONCLUSIVE", reason: "Judge unavailable", rubric_version: expectation.rubric_version }); continue; }
					if (report.tokens !== null && report.tokens >= c.max_tokens) { report.checks.push({ status: "BLOCKED", reason: "No judge token budget remaining" }); continue; }
					try {
						const response = await bounded(s => options.judge!.evaluate(expectation.rubric, report.evidence, s, c.max_tokens - (report.tokens ?? 0)), controller.signal);
						const v = parseJudgeVerdict(response.verdict, report.evidence.map(e => e.id));
						if (response.tokens !== undefined && (!Number.isFinite(response.tokens) || response.tokens < 0)) throw new Error("Invalid judge token accounting");
						if (response.tokens !== undefined) report.tokens = (report.tokens ?? 0) + response.tokens;
						report.checks.push({ status: (report.tokens ?? 0) > c.max_tokens ? "FAIL" : v.score >= expectation.threshold ? "PASS" : "FAIL", reason: v.reason, rubric_version: expectation.rubric_version, verdict: v });
					} catch (error) { report.checks.push({ status: "INCONCLUSIVE", reason: redactEvidence(String(error)), rubric_version: expectation.rubric_version }); }
				}
			}
		}
	} catch (error) { report.checks.push({ status: "INCONCLUSIVE", reason: redactEvidence(String(error)) }); }
	finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
	report.status = aggregateEvalStatus(report.checks.map(c => c.status));
	report.elapsed_ms = Date.now() - started;
	return report;
}

