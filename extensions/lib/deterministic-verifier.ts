// ABOUTME: Deterministic assertion runner for the acceptance contract. No LLM in
// ABOUTME: the decision path: [cmd] execFile (no shell). Timeouts and missing
// ABOUTME: commands are BLOCKED, not guessed.

import { execFile, type ExecFileException } from "node:child_process";
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
