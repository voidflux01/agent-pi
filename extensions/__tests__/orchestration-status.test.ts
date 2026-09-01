import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import orchestrationStatus from "../orchestration-status.ts";
import { createOrchestrationRun } from "../lib/orchestration-run.ts";

describe("orchestration status inspection", () => {
	test("returns bounded event payloads for an exact run", async () => {
		const tools: any[] = [];
		const commands: any[] = [];
		const fakePi: any = {
			registerTool(definition: any) { tools.push(definition); },
			registerCommand(name: string, definition: any) { commands.push({ name, ...definition }); },
			on() {},
		};
		const cwd = mkdtempSync(join(tmpdir(), "orchestration-status-"));
		const root = join(cwd, ".pi", "agent-sessions", "compositions");
		mkdirSync(root, { recursive: true });
		const seed = join(root, "seed");
		const run = createOrchestrationRun({ eventDir: seed, actor: "test", mode: "PLAN" });
		run.recordUsage({ totalTokens: 12, costUsd: 0.003 });
		run.record("step.completed", { index: 0, result: { text: "handoff" } });
		run.finish("succeeded");
		renameSync(seed, join(root, run.runId));
		orchestrationStatus(fakePi);
		const tool = tools.find((entry) => entry.name === "orchestration_status");
		const result = await tool.execute("status", { run_id: run.runId, include_events: true }, undefined, undefined, { cwd });
		expect(result.details).toMatchObject({ count: 1, runs: [{ totalTokens: 12, costUsd: 0.003 }] });
		expect(result.content[0].text).toContain("usage.updated");
		expect(result.content[0].text).toContain('"totalTokens":12');
		const filtered = await tool.execute("status", { mode: "SPEC" }, undefined, undefined, { cwd });
		expect(filtered.details.count).toBe(0);
		const matched = await tool.execute("status", { mode: "plan" }, undefined, undefined, { cwd });
		expect(matched.details.count).toBe(1);
		expect(matched.details.modeMetrics.PLAN).toMatchObject({ runs: 1, succeeded: 1, totalTokens: 12 });

		const notices: string[] = [];
		const command = commands.find((entry) => entry.name === "orchestration-status");
		await command.handler(`events ${run.runId}`, { cwd, ui: { notify(message: string) { notices.push(message); } } });
		expect(notices[0]).toContain("step.completed");
		await command.handler("mode PLAN", { cwd, ui: { notify(message: string) { notices.push(message); } } });
		expect(notices.at(-1)).toContain("PLAN");
		await command.handler("mode SPEC", { cwd, ui: { notify(message: string) { notices.push(message); } } });
		expect(notices.at(-1)).toContain("No persisted SPEC");
	});

	test("returns a safe recovery plan without replaying stale compose work", async () => {
		const tools: any[] = [];
		const fakePi: any = {
			registerTool(definition: any) { tools.push(definition); },
			registerCommand() {},
			on() {},
		};
		const cwd = mkdtempSync(join(tmpdir(), "orchestration-recover-"));
		const root = join(cwd, ".pi", "agent-sessions", "compositions");
		mkdirSync(root, { recursive: true });
		const seed = join(root, "seed");
		const run = createOrchestrationRun({ eventDir: seed, actor: "compose_exec", mode: "NORMAL" });
		writeFileSync(join(seed, "active.json"), JSON.stringify({ pid: 2147483647 }));
		renameSync(seed, join(root, run.runId));
		orchestrationStatus(fakePi);
		const recover = tools.find((entry) => entry.name === "orchestration_recover");
		const result = await recover.execute("recover", { run_id: run.runId }, undefined, undefined, { cwd });
		expect(result.details).toMatchObject({ found: true, recoverable: true, action: "compose-resume", target: run.runId });
		expect(result.content[0].text).toContain("resume_run_id");
	});
});
