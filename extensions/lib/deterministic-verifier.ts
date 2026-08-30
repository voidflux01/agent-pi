// ABOUTME: Deterministic assertion runner for the acceptance contract. No LLM in
// ABOUTME: the decision path: [cmd] execFile (no shell), [file] existence in
// ABOUTME: workspace, [match] regex against file content. Timeouts, missing
// ABOUTME: commands, and path escapes are BLOCKED, not guessed.

import { execFile, type ExecFileException } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ContractAssertion, VerificationStatus } from "./execution-contract.ts";

export interface AssertionResult {
	kind: ContractAssertion["kind"];
	raw: string;
	status: "pass" | "fail" | "blocked";
	exitCode?: number;
	stdout?: string;
	stderr?: string;
	note?: string;
}

export interface DeterministicVerification {
	status: VerificationStatus;
	results: AssertionResult[];
}

export interface VerifierConfig {
	/** Per-command timeout in ms. */
	commandTimeoutMs?: number;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

export class PathEscapeError extends Error {}

function checkLexicalInsideRoot(root: string, candidate: string): string {
	const absolute = resolve(root, candidate);
	const rootAbsolute = resolve(root);
	if (!absolute.startsWith(rootAbsolute + "/") && absolute !== rootAbsolute) {
		throw new PathEscapeError(`path escapes workspace: ${candidate}`);
	}
	return absolute;
}

function checkInsideRoot(root: string, candidate: string): string {
	const absolute = checkLexicalInsideRoot(root, candidate);
	const stat = lstatSync(absolute);
	if (stat.isSymbolicLink()) throw new PathEscapeError(`symlink paths are not allowed: ${candidate}`);
	const rootAbsolute = resolve(root);
	const realRoot = realpathSync(rootAbsolute);
	const realCandidate = realpathSync(absolute);
	if (!realCandidate.startsWith(realRoot + "/") && realCandidate !== realRoot) {
		throw new PathEscapeError(`path escapes workspace via symlink: ${candidate}`);
	}
	return realCandidate;
}

function runCommand(
	raw: string,
	command: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
): Promise<AssertionResult> {
	return new Promise(resolveResult => {
		execFile(command, args, {
			cwd,
			timeout: timeoutMs,
			encoding: "utf8",
			maxBuffer: 4 * 1024 * 1024,
			windowsHide: true,
		}, (error: ExecFileException | null, stdout: string, stderr: string) => {
			if (!error) {
				resolveResult({
					kind: "cmd",
					raw,
					status: "pass",
					exitCode: 0,
					stdout: stdout.slice(0, 4000),
					stderr: stderr.slice(0, 4000),
				});
				return;
			}
			const errno = (error as NodeJS.ErrnoException).code;
			const killed = (error as { killed?: boolean }).killed;
			if (errno === "ENOENT") {
				resolveResult({ kind: "cmd", raw, status: "blocked", exitCode: 127, stderr, note: `command not found: ${command}` });
				return;
			}
			if (errno === "EACCES") {
				resolveResult({ kind: "cmd", raw, status: "blocked", exitCode: 126, stderr, note: `command not executable: ${command}` });
				return;
			}
			if (killed || errno === "ETIMEDOUT") {
				resolveResult({ kind: "cmd", raw, status: "blocked", note: `timed out after ${timeoutMs}ms: ${command}` });
				return;
			}
			const code = typeof error.code === "number" ? error.code : undefined;
			resolveResult({
				kind: "cmd",
				raw,
				status: "fail",
				exitCode: code,
				stdout: stdout.slice(0, 4000),
				stderr: stderr.slice(0, 4000),
				note: error.message,
			});
		});
	});
}

export async function runAssertion(assertion: ContractAssertion, root: string, config: VerifierConfig = {}): Promise<AssertionResult> {
	const timeoutMs = config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
	switch (assertion.kind) {
		case "advisory":
			return { kind: "advisory", raw: assertion.raw, status: "pass", note: "advisory — not part of the PASS decision" };
		case "cmd":
			return runCommand(assertion.raw, assertion.command, assertion.args, root, timeoutMs);
		case "file": {
			try {
				const lexical = checkLexicalInsideRoot(root, assertion.path);
				if (!existsSync(lexical)) {
					return { kind: "file", raw: assertion.raw, status: "fail", note: `file missing: ${assertion.path}` };
				}
				const absolute = checkInsideRoot(root, assertion.path);
				if (!statSync(absolute).isFile()) return { kind: "file", raw: assertion.raw, status: "fail", note: `not a file: ${assertion.path}` };
				return { kind: "file", raw: assertion.raw, status: "pass" };
			} catch (error) {
				return { kind: "file", raw: assertion.raw, status: "blocked", note: error instanceof Error ? error.message : String(error) };
			}
		}
		case "match": {
			try {
				const lexical = checkLexicalInsideRoot(root, assertion.path);
				if (!existsSync(lexical)) {
					return { kind: "match", raw: assertion.raw, status: "fail", note: `file missing: ${assertion.path}` };
				}
				const absolute = checkInsideRoot(root, assertion.path);
				if (!statSync(absolute).isFile()) return { kind: "match", raw: assertion.raw, status: "fail", note: `not a file: ${assertion.path}` };
				let pattern: RegExp;
				try {
					pattern = new RegExp(assertion.pattern);
				} catch (error) {
					return { kind: "match", raw: assertion.raw, status: "blocked", note: `invalid regex: ${error instanceof Error ? error.message : String(error)}` };
				}
				const content = readFileSync(absolute, "utf8");
				if (pattern.test(content)) return { kind: "match", raw: assertion.raw, status: "pass" };
				return { kind: "match", raw: assertion.raw, status: "fail", note: `pattern not found in ${assertion.path}` };
			} catch (error) {
				return { kind: "match", raw: assertion.raw, status: "blocked", note: error instanceof Error ? error.message : String(error) };
			}
		}
	}
}

/** Run every mandatory assertion sequentially; a single fail/blocked fails the run. */
export async function runDeterministicVerification(
	contract: { mandatory: ContractAssertion[] },
	root: string,
	config: VerifierConfig = {},
): Promise<DeterministicVerification> {
	const results: AssertionResult[] = [];
	for (const assertion of contract.mandatory) {
		results.push(await runAssertion(assertion, root, config));
	}
	const blocked = results.some(r => r.status === "blocked");
	const failed = results.some(r => r.status === "fail");
	const status: VerificationStatus = blocked ? "BLOCKED" : failed ? "FAIL" : "PASS";
	return { status, results };
}
