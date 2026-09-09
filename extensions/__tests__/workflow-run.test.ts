import { beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import workflowSupport from "../workflow-support.ts";
import { createWorkflowRun, loadLatestWorkflowRun, saveWorkflowRun } from "../lib/workflow-run.ts";
import { bindAcceptanceContract } from "../lib/execution-contract.ts";
import { buildWorkspaceManifest } from "../lib/workspace-manifest.ts";
import { coordinationState, resetExecutionVerification } from "../lib/coordination-state.ts";
const runVerifier = mock();
mock.module("../lib/isolated-verifier.ts", () => ({ runAcceptanceVerifier: runVerifier }));
// Dynamic import is required so Bun applies verifier mock before module evaluation.
const { runAutonomousCompletion } = await import("../lib/autonomous-completion.ts");

function setup() {
	const commands: any[] = [];
	const messages: string[] = [];
	const notices: Array<{ message: string; level: string }> = [];
	const pi = {
		registerTool() { },
		registerCommand(name: string, definition: any) { commands.push({ name, ...definition }); },
		on() { },
		sendUserMessage: mock(async (message: string) => { messages.push(message); }),
	};
	workflowSupport(pi as any);
	const command = commands.find((entry) => entry.name === "workflow");
	const cwd = mkdtempSync(join(tmpdir(), "workflow-run-command-"));
	const ctx = { cwd, ui: { notify(message: string, level: string) { notices.push({ message, level }); } } };
	return { command, cwd, ctx, messages, notices, pi };
}

function receipt(cwd: string, contract: any, status: "PASS" | "FAIL") {
	return {
		version: 3 as const,
		status,
		contractFingerprint: contract.fingerprint,
		workspaceManifestHash: buildWorkspaceManifest(cwd, contract.fingerprint).hash,
		results: status === "PASS" ? [] : [{ kind: "advisory" as const, raw: "repair needed", status: "blocked" as const, note: "fix" }],
		attempt: 1,
		verifierRequired: true,
		verifier: { runId: "verifier-1", status, summary: status === "PASS" ? "pass" : "fail" },
		createdAt: new Date().toISOString(),
	};
}

beforeEach(() => {
	runVerifier.mockReset();
	resetExecutionVerification();
});

describe("workflow run command", () => {
	it("starts one redacted run and rejects a second active run", async () => {
		const { command, cwd, ctx, messages } = setup();
		await command.handler("run Build a login page token=secret", ctx);
		const run = loadLatestWorkflowRun(cwd);
		expect(run).toMatchObject({ status: "RUNNING", objective: "Build a login page token=[REDACTED]" });
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain(run!.run_id);
		await command.handler("run Another page", ctx);
		expect(messages).toHaveLength(1);
		expect(ctx.ui.notify).toBeDefined();
	});

	it("reports, resumes, cancels and refuses terminal resume", async () => {
		const { command, cwd, ctx, messages, notices } = setup();
		await command.handler("run Build a login page", ctx);
		const run = loadLatestWorkflowRun(cwd)!;
		await command.handler("status", ctx);
		expect(notices.at(-1)?.message).toContain(run.run_id);
		await command.handler("resume", ctx);
		expect(messages).toHaveLength(2);
		expect(messages[1]).toContain(run.run_id);
		await command.handler("cancel", ctx);
		expect(loadLatestWorkflowRun(cwd)?.status).toBe("CANCELLED");
		expect(messages).toHaveLength(2);
		await command.handler("resume", ctx);
		expect(messages).toHaveLength(2);
		expect(notices.at(-1)?.message).toContain("terminal");
	});

	it("handles empty and corrupt state without starting work", async () => {
		const empty = setup();
		await empty.command.handler("run", empty.ctx);
		expect(empty.messages).toHaveLength(0);
		const corrupt = setup();
		mkdirSync(join(corrupt.cwd, ".pi", "workflow", "runs"), { recursive: true });
		writeFileSync(join(corrupt.cwd, ".pi", "workflow", "runs", "bad.json"), "not-json");
		await corrupt.command.handler("status", corrupt.ctx);
		await corrupt.command.handler("resume", corrupt.ctx);
		await corrupt.command.handler("run New task", corrupt.ctx);
		expect(corrupt.notices.filter((item) => item.message === "No workflow run")).toHaveLength(2);
		expect(corrupt.messages).toHaveLength(0);
	});
});

describe("workflow run verifier lifecycle", () => {
	it("marks linked run complete only after verifier PASS", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "workflow-run-pass-"));
		const run = createWorkflowRun(cwd, "Ship login page");
		saveWorkflowRun(cwd, run);
		const bound = bindAcceptanceContract("## Objective\nShip login page", "task");
		if ("error" in bound) throw new Error("expected contract");
		runVerifier.mockResolvedValueOnce({ receipt: receipt(cwd, bound, "PASS") });
		const result = await runAutonomousCompletion({ contract: bound, cwd, mode: "NORMAL", runId: run.run_id });
		expect(result.allowed).toBe(true);
		expect(loadLatestWorkflowRun(cwd)).toMatchObject({ status: "COMPLETE", run_id: run.run_id, contract_fingerprint: bound.fingerprint });
	});

	it("marks REPLAN as waiting approval without changing approval state", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "workflow-run-replan-"));
		const run = createWorkflowRun(cwd, "Clarify login requirements");
		saveWorkflowRun(cwd, run);
		const bound = bindAcceptanceContract("## Objective\nClarify login requirements", "task");
		if ("error" in bound) throw new Error("expected contract");
		const state = coordinationState();
		state.planApproved = true;
		runVerifier.mockResolvedValueOnce({ receipt: receipt(cwd, bound, "FAIL") });
		const result = await runAutonomousCompletion({ contract: bound, cwd, mode: "NORMAL", runId: run.run_id, failure: "requirements" });
		expect(result.iteration).toMatchObject({ action: "REPLAN", nextMode: "SPEC", requiresApproval: true });
		expect(loadLatestWorkflowRun(cwd)).toMatchObject({ status: "WAITING_APPROVAL", next_action: expect.stringContaining("fresh approval") });
		expect(state.planApproved).toBe(true);
	});
});
