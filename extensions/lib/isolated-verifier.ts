// ABOUTME: Spawns a read-mostly isolated pi child to verify the current acceptance contract.
// ABOUTME: Dispatch is injectable so tests cover the shipped runner without a live model.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AcceptanceContract } from "./execution-contract.ts";
import type { DispatchAuthorization } from "./dispatch-gate.ts";
import { run as runDispatch } from "./dispatch-runtime.ts";
import { childEnvironment } from "./child-runtime.ts";
import { redactSensitive } from "./sensitive-data.ts";
import {
	buildVerifierPrompt,
	collectCommandFromEvent,
	createVerifierReceipt,
	workspaceHash,
	type VerifierReceipt,
} from "./verifier-runtime.ts";

export interface VerifierExecuteResult {
	output: string;
	commandsRun: string[];
	exitCode: number;
	stderr?: string;
}

export type VerifierExecute = (input: {
	prompt: string;
	cwd: string;
	authorization: DispatchAuthorization;
	launchDir: string;
	launchId: string;
}) => Promise<VerifierExecuteResult>;

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

function porcelain(cwd: string): string {
	try {
		return git(cwd, ["status", "--porcelain"])
			.split("\n")
			.filter(line => {
				const path = line.slice(3).trim();
				return path.length > 0 && !path.startsWith(".pi/");
			})
			.join("\n");
	} catch { return ""; }
}

/** Isolated verifier runs without host extensions; only the security guard is loaded. */
export const VERIFIER_TOOLS = "read,grep,find,ls,bash,run_tests";

export function verifierDispatchCommand(prompt: string): string[] {
	const guard = join(dirname(fileURLToPath(import.meta.url)), "..", "security-guard.ts");
	return ["pi", "--mode", "json", "-p", "--no-extensions", "-e", guard, "--tools", VERIFIER_TOOLS, prompt];
}

export async function defaultVerifierExecute(input: {
	prompt: string;
	cwd: string;
	authorization: DispatchAuthorization;
	launchDir: string;
	launchId: string;
}): Promise<VerifierExecuteResult> {
	const chunks: string[] = [];
	const commandsRun: string[] = [];
	const result = await runDispatch({
		authorization: input.authorization,
		command: verifierDispatchCommand(input.prompt),
		cwd: input.cwd,
		env: childEnvironment({ PI_SUBAGENT: "1", PI_AGENT_NAME: "reviewer-verifier" }),
		launchDir: input.launchDir,
		launchId: input.launchId,
		transport: "headless",
		pollTimeoutMs: 15 * 60 * 1000,
		onStdoutLine: line => {
			try {
				const event = JSON.parse(line) as Record<string, unknown>;
				if (event.type === "message_update") {
					const delta = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
					if (delta?.type === "text_delta") chunks.push(delta.delta || "");
				}
				const command = collectCommandFromEvent(event);
				if (command) commandsRun.push(command);
			} catch { /* ignore non-JSON */ }
		},
	});
	return {
		output: result.outputText || chunks.join(""),
		commandsRun,
		exitCode: result.exitCode,
		stderr: result.stderr,
	};
}

export async function runIsolatedVerifier(input: {
	cwd: string;
	contract: AcceptanceContract;
	authorization: DispatchAuthorization;
	attempt: number;
	launchDir?: string;
	execute?: VerifierExecute;
}): Promise<{ receipt?: VerifierReceipt; error?: string }> {
	const launchDir = input.launchDir || join(input.cwd, ".pi", "agent-sessions");
	mkdirSync(launchDir, { recursive: true });
	const before = porcelain(input.cwd);
	let diff = "";
	let files: string[] = [];
	try {
		diff = git(input.cwd, ["diff", "--no-ext-diff", "--", "."]);
		files = git(input.cwd, ["diff", "--name-only", "--no-ext-diff"]).split("\n").filter(Boolean);
	} catch (error) {
		return { error: `Verification blocked: unable to inspect git workspace (${error instanceof Error ? error.message : String(error)})` };
	}
	const artifactDir = join(launchDir, `verifier-${input.contract.fingerprint.slice(0, 24)}-${input.attempt}`);
	mkdirSync(artifactDir, { recursive: true });
	const diffPath = join(artifactDir, "diff.patch");
	writeFileSync(diffPath, redactSensitive(diff), "utf8");
	const prompt = buildVerifierPrompt({
		contract: input.contract,
		diffPath,
		evidencePaths: [diffPath],
	});
	const execute = input.execute || defaultVerifierExecute;
	let result: VerifierExecuteResult;
	try {
		result = await execute({
			prompt,
			cwd: input.cwd,
			authorization: input.authorization,
			launchDir: artifactDir,
			launchId: `verifier-${input.contract.fingerprint.slice(0, 16)}-${input.attempt}`,
		});
	} catch (error) {
		return { error: `Verification blocked: verifier process could not start (${error instanceof Error ? error.message : String(error)})` };
	}
	const after = porcelain(input.cwd);
	if (after !== before) {
		return { error: "Verification blocked: verifier modified the workspace." };
	}
	if (result.exitCode !== 0) {
		return { error: `Verifier process failed (exit ${result.exitCode}): ${result.stderr || result.output.slice(-1200)}` };
	}
	const receipt = createVerifierReceipt({
		output: result.output,
		contract: input.contract,
		commandsRun: result.commandsRun,
		changedFiles: files,
		attempt: input.attempt,
		workspaceHash: workspaceHash(diff, files),
	});
	if (!receipt) return { error: "Verifier returned no unambiguous decision." };
	return { receipt };
}
