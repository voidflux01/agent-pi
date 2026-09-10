import { beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import workflowSupport from "../workflow-support.ts";
import { createWorkflowRun, loadLatestWorkflowRun, loadWorkflowRun, markWorkflowRunComplete, saveWorkflowRun } from "../lib/workflow-run.ts";
import { bindAcceptanceContract } from "../lib/execution-contract.ts";
import { buildWorkspaceManifest } from "../lib/workspace-manifest.ts";
import { coordinationState, resetExecutionVerification, resetWorkflowRunLink } from "../lib/coordination-state.ts";
const runVerifier = mock();
mock.module("../lib/isolated-verifier.ts", () => ({ runAcceptanceVerifier: runVerifier }));
// Dynamic import is required so Bun applies verifier mock before module evaluation.
const { runAutonomousCompletion } = await import("../lib/autonomous-completion.ts");

function setup() {
	const commands: any[] = [];
	const messages: string[] = [];
	const notices: Array<{ message: string; level: string }> = [];
	const handlers: Record<string, Function> = {};
	const pi = {
		registerTool() { },
		registerCommand(name: string, definition: any) { commands.push({ name, ...definition }); },
		on(event: string, handler: Function) { handlers[event] = handler; },
		sendUserMessage: mock(async (message: string) => { messages.push(message); }),
	};
	workflowSupport(pi as any);
	const command = commands.find((entry) => entry.name === "workflow");
	const cwd = mkdtempSync(join(tmpdir(), "workflow-run-command-"));
	const ctx = { cwd, ui: { notify(message: string, level: string) { notices.push({ message, level }); } } };
	return { command, cwd, ctx, messages, notices, handlers, pi };
}

function receipt(cwd: string, contract: any, status: "PASS" | "FAIL") {
	return {
		version: 3 as const,
		status,
		contractFingerprint: contract.fingerprint,
		workspaceManifestHash: buildWorkspaceManifest(cwd, contract.fingerprint).hash,
		results: status === "PASS" ? [] : [{ raw: "repair needed", status: "fail" as const, note: "fix" }],
		attempt: 1,
		verifier: { runId: "verifier-1", status, summary: status === "PASS" ? "pass" : "fail" },
		createdAt: new Date().toISOString(),
	};
}

beforeEach(() => {
	runVerifier.mockReset();
	resetExecutionVerification();
	resetWorkflowRunLink();
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

	it("blocks exact run when kickoff send fails", async () => {
		const { command, cwd, ctx, pi } = setup();
		pi.sendUserMessage = mock(async () => { throw new Error("send failed"); });
		await command.handler("run Cannot start", ctx);
		const run = loadLatestWorkflowRun(cwd)!;
		expect(run).toMatchObject({ status: "BLOCKED", next_action: "Agent turn could not start" });
	});

	it("reconciles orphaned runs but rejects runs with live ownership", async () => {
		const orphan = setup();
		const old = createWorkflowRun(orphan.cwd, "Interrupted work");
		saveWorkflowRun(orphan.cwd, old);
		await orphan.command.handler("run New work", orphan.ctx);
		expect(loadWorkflowRun(orphan.cwd, old.run_id)).toMatchObject({ status: "BLOCKED", next_action: "Previous workflow execution ended before reaching a terminal report" });
		expect(orphan.messages).toHaveLength(1);

		const live = setup();
		await live.command.handler("run Existing work", live.ctx);
		const current = loadLatestWorkflowRun(live.cwd)!;
		await live.command.handler("run Second work", live.ctx);
		expect(loadWorkflowRun(live.cwd, current.run_id)?.status).toBe("RUNNING");
		expect(live.messages).toHaveLength(1);
	});

	it("blocks linked run once on session termination", async () => {
		const { command, cwd, ctx, handlers } = setup();
		await command.handler("run Work in progress", ctx);
		const run = loadLatestWorkflowRun(cwd)!;
		await handlers.session_shutdown({}, ctx);
		const blocked = loadWorkflowRun(cwd, run.run_id)!;
		expect(blocked).toMatchObject({ status: "BLOCKED", next_action: expect.stringContaining("ended") });
		const updatedAt = blocked.updated_at;
		await handlers.session_shutdown({}, ctx);
		expect(loadWorkflowRun(cwd, run.run_id)?.updated_at).toBe(updatedAt);
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
		expect(loadWorkflowRun(cwd, run.run_id)).toMatchObject({ status: "RUNNING", run_id: run.run_id, contract_fingerprint: bound.fingerprint, next_action: "Verifier PASS; call show_report" });
		markWorkflowRunComplete(cwd, run.run_id);
		expect(loadWorkflowRun(cwd, run.run_id)?.status).toBe("COMPLETE");
	});

	it("keeps exact run running after repairable verifier FAIL", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "workflow-run-fail-"));
		const run = createWorkflowRun(cwd, "Repair login page");
		saveWorkflowRun(cwd, run);
		const bound = bindAcceptanceContract("## Objective\nRepair login page", "task");
		if ("error" in bound) throw new Error("expected contract");
		runVerifier.mockResolvedValueOnce({ receipt: receipt(cwd, bound, "FAIL") });
		const result = await runAutonomousCompletion({ contract: bound, cwd, mode: "NORMAL", runId: run.run_id, dispatchRepair: async () => false });
		expect(result.status).toBe("FAIL");
		expect(loadWorkflowRun(cwd, run.run_id)).toMatchObject({ status: "RUNNING", run_id: run.run_id, contract_fingerprint: bound.fingerprint, next_action: expect.stringContaining("repair") });
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
