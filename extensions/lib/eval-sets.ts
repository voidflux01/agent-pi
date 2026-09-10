// ABOUTME: User workspace eval-set loading, executor dispatch and the mandatory-eval gate.
// ABOUTME: User commands run through execFile without a shell, only when a case declares the command executor.

import { execFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { digest, readBounded } from "./workflow-artifacts.ts";
import { tokenizeCommand } from "./execution-contract.ts";
import { evaluateCase, parseEvalCase, type EvalCase, type EvalExecution, type EvalReport, type JudgeAdapter } from "./eval-engine.ts";

const USER_EVAL_DIR = ".pi/workflow/evals";
export const REQUIRED_EVAL_MAX_AGE_MS_DEFAULT = 24 * 60 * 60 * 1000;
const MAX_SCANNED_REPORTS = 50;
const MAX_OUTPUT_BYTES = 60000;

export interface EvalSet {
	schema_version: 1;
	name: string;
	version: number;
	/** Content hash of the raw file; contracts bind this, not the file path. */
	sha256: string;
	cases: EvalCase[];
}

export function parseEvalSet(raw: unknown, sha256: string): EvalSet {
	const source = raw as { schema_version?: unknown; name?: unknown; version?: unknown; cases?: unknown; eval_set?: { name?: unknown; version?: unknown } };
	if (!source || typeof source !== "object" || !Array.isArray(source.cases) || source.cases.length < 1 || source.cases.length > 50) throw new Error("Invalid eval set: cases must be an array of 1–50");
	const name = (typeof source.name === "string" && source.name.trim() ? source.name : typeof source.eval_set?.name === "string" ? source.eval_set.name : "").trim();
	const version = Number.isInteger(source.version) ? source.version : source.eval_set?.version;
	if (!/^[a-zA-Z0-9-_]{1,80}$/.test(name) || !Number.isInteger(version) || (version as number) < 1) throw new Error("Invalid eval set identity");
	if (source.schema_version !== undefined && source.schema_version !== 1) throw new Error("Unsupported eval set schema version");
	return { schema_version: 1, name, version: version as number, sha256, cases: source.cases.map(parseCase) };
}

function parseCase(raw: unknown): EvalCase {
	// User sets must declare an executor; default to "command" so a user's own
	// test command runs, matching the plan's "user-project existing tests" entry.
	const c = raw as EvalCase;
	if (c && typeof c === "object" && c.executor === undefined) c.executor = "command";
	return parseEvalCase(c);
}

export function loadEvalSet(cwd: string, path: string): EvalSet {
	if (typeof path !== "string" || path.endsWith("/")) throw new Error("Eval set path must be a workspace file");
	const raw = readBounded(cwd, path, 256 * 1024);
	const sha256 = digest(raw);
	const parsed = /\.(ya?ml)$/i.test(path) ? YAML.parse(raw) : JSON.parse(raw);
	return parseEvalSet(parsed, sha256);
}

/** Command executor: no shell, bounded output, abort signal kills the child. */
export function runCommandExecution(cwd: string, c: EvalCase, signal: AbortSignal): Promise<EvalExecution> {
	const tokens = tokenizeCommand(c.command!);
	const [command, ...args] = tokens;
	if (!command || command.split("/").includes("..")) return Promise.resolve({ output: "", exitCode: null, blocked: "Command executor rejected the tokenized command" });
	return new Promise((resolve, reject) => {
		execFile(command, args, { cwd, timeout: Math.min(c.timeout_ms, 900000), maxBuffer: 1024 * 1024, signal, windowsHide: true }, (error, stdout, stderr) => {
			if (signal.aborted) return reject(new Error("Evaluation cancelled or timed out"));
			if (error && typeof (error as NodeJS.ErrnoException).code === "string" && !(error as unknown as { killed?: boolean }).killed) {
				// Spawn failures (missing binary, permissions) are blocked, not FAIL evidence.
				return resolve({ output: `${stdout}\n${stderr}`, exitCode: null, blocked: `Command could not start: ${error.message.split("\n")[0]}` });
			}
			let output = `${stdout}\n${stderr}`;
			if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) output = Buffer.from(output).subarray(0, MAX_OUTPUT_BYTES).toString("utf8") + "\n[TRUNCATED]";
			// Nonzero exits are evidence for the exit expectation, not runner errors.
			const exitCode = error ? (typeof (error as unknown as { code?: unknown }).code === "number" ? (error as unknown as { code: number }).code : 1) : 0;
			resolve({ output, exitCode, tokens: 0, model: `command:${command}` });
		});
	});
}

function unavailableExecution(reason: string): Promise<EvalExecution> {
	return Promise.resolve({ output: "", exitCode: null, blocked: reason });
}

export async function runUserEvalSet(cwd: string, set: EvalSet, options: { signal?: AbortSignal; judge?: JudgeAdapter } = {}): Promise<EvalReport[]> {
	const reports: EvalReport[] = [];
	for (const c of set.cases) {
		const report = await evaluateCase(c, (signal) => {
			if (c.executor === "command") return runCommandExecution(cwd, c, signal);
			if (c.executor === "pi-workflow") return unavailableExecution("pi-workflow executor requires the live orchestration harness (scripts/orchestration-eval.ts) with a configured model; not available in provider-free eval_run");
			return unavailableExecution("provider-free executor only applies to the bundled regression cases");
		}, { judge: options.judge, signal: options.signal });
		report.executor = c.executor;
		report.eval_set = set.name;
		report.eval_set_sha256 = set.sha256;
		reports.push(report);
	}
	return reports;
}

export interface EvalGateResult { ok: boolean; reason: string; reportPath?: string; }

/** Mandatory-eval gate: a fresh PASS report whose eval-set hash matches the contract binding. */
export function checkRequiredEvalBinding(cwd: string, binding: { path: string; sha256: string }, maxAgeMs = REQUIRED_EVAL_MAX_AGE_MS_DEFAULT): EvalGateResult {
	const dir = join(cwd, USER_EVAL_DIR);
	let entries: string[] = [];
	try { entries = readdirSync(dir).filter(name => /^[a-zA-Z0-9-]{4,80}\.json$/.test(name)); } catch { /* No reports yet. */ }
	entries = entries
		.map(name => { try { return { name, mtime: statSync(join(dir, name)).mtimeMs }; } catch { return { name, mtime: 0 }; } })
		.sort((a, b) => b.mtime - a.mtime)
		.slice(0, MAX_SCANNED_REPORTS)
		.map(entry => entry.name);
	for (const name of entries) {
		try {
			const report = JSON.parse(readBounded(cwd, join(USER_EVAL_DIR, name), 256 * 1024)) as EvalReport;
			if (report?.schema_version !== 1 || report.eval_set_sha256 !== binding.sha256) continue;
			if (report.status !== "PASS") continue;
			const created = Date.parse(report.created_at);
			if (!Number.isFinite(created) || Date.now() - created > maxAgeMs) continue;
			return { ok: true, reason: `Fresh PASS eval report matches required set ${binding.path}`, reportPath: join(USER_EVAL_DIR, name) };
		} catch { /* Corrupt reports cannot satisfy the gate. */ }
	}
	return { ok: false, reason: `No fresh PASS eval report for required set ${binding.path} (sha256 ${binding.sha256.slice(0, 12)}…). Run eval_run with that eval set, then re-verify.` };
}
