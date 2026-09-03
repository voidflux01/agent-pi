// ABOUTME: Guards the chain/team/pipeline walk-through fixes: RESULT one-liners,
// ABOUTME: pipeline advance gates, default team, and select labels.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkerInitialPrompt, normalizeResultContract, resultOneLiner } from "../lib/agent-result-contract.ts";
import { phaseRequiresAgentDispatch, pipelineSelectLabel, type PipelineConfig } from "../lib/parse-pipeline-yaml.ts";
import { defaultTeamName } from "../agent-team.ts";
import { ORCHESTRATED_TASK_PROMPT } from "../lib/mode-prompts.ts";
import { buildAgentResultContractPrompt } from "../lib/agent-result-contract.ts";

describe("resultOneLiner", () => {
	it("uses summary from ## RESULT instead of the ## END line", () => {
		const full = [
			"working...",
			"## RESULT",
			"done: true",
			"summary: created /tmp/wf-walk/hello.py and verified stdout 84",
			"- files: /tmp/wf-walk/hello.py",
			"## END",
		].join("\n");
		expect(resultOneLiner(full, "")).toBe("created /tmp/wf-walk/hello.py and verified stdout 84");
		expect(resultOneLiner(full, "")).not.toContain("## END");
	});

	it("keeps detailed findings while normalizing inline done output", () => {
		const raw = [
			"## RESULT",
			"done: true — reconnaissance completed",
			"findings:",
			"- src/ui.rs:120 uses the calendar grid",
			"## END",
		].join("\n");
		const normalized = normalizeResultContract(raw);
		expect(normalized?.text).toContain("done: true\nsummary: reconnaissance completed");
		expect(normalized?.text).toContain("- src/ui.rs:120 uses the calendar grid");
	});
});

describe("worker first-turn prompt", () => {
	it("puts the protocol in the initial task message", () => {
		const prompt = buildWorkerInitialPrompt({ role: "SCOUT", task: "inspect the repository", rolePrompt: "Read-only." });
		expect(prompt).toContain("Task:\ninspect the repository");
		expect(prompt).toContain("## RESULT");
		expect(prompt).toContain("findings:");
	});
});

describe("pipeline dispatch_agents records success on the phase", () => {
	it("assigns lastDispatchSuccess on phase, not an undefined phaseState", () => {
		const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "pipeline-team.ts"), "utf8");
		expect(src).toContain("phase.lastDispatchSuccess = result.success");
		expect(src).not.toContain("phaseState.lastDispatchSuccess = result.success");
	});
});

describe("phaseRequiresAgentDispatch", () => {
	it("lets UNDERSTAND advance without dispatch", () => {
		expect(phaseRequiresAgentDispatch({ name: "understand", agents: [{ role: "scout" }] })).toBe(false);
	});

	it("requires dispatch for plan and build", () => {
		expect(phaseRequiresAgentDispatch({ name: "plan", agents: [{ role: "planner" }] })).toBe(true);
		expect(phaseRequiresAgentDispatch({ name: "build", agents: [{ role: "builder" }] })).toBe(true);
	});
});

describe("pipelineSelectLabel", () => {
	it("shows name and full phase flow", () => {
		const cfg: PipelineConfig = {
			name: "plan-build",
			description: "Plan then build",
			review_max_loops: 1,
			phases: [
				{ name: "plan", description: "", mode: "interactive", agents: [] },
				{ name: "build", description: "", mode: "interactive", agents: [] },
			],
		};
		expect(pipelineSelectLabel(cfg)).toBe("plan-build (plan → build)");
	});
});

describe("defaultTeamName", () => {
	it("prefers plan-build over all", () => {
		expect(defaultTeamName({
			all: ["scout", "builder", "reviewer", "tester", "warden"],
			"plan-build": ["planner", "builder", "reviewer"],
		})).toBe("plan-build");
	});
});

describe("orchestrator RESULT trust", () => {
	it("treats child output as untrusted and requires independent verification", () => {
		expect(ORCHESTRATED_TASK_PROMPT).toContain("untrusted report");
		expect(ORCHESTRATED_TASK_PROMPT).toContain("deterministic assertions");
		expect(ORCHESTRATED_TASK_PROMPT).toContain("PASS");
		expect(buildAgentResultContractPrompt()).toContain("untrusted worker claim");
	});
});

describe("source wiring", () => {
	it("keeps PIPELINE dispatch separate from CHAIN and standalone subagents", () => {
		const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "pipeline-team.ts"), "utf8");
		expect(source).toContain("PIPELINE");
		expect(source).toContain("subagent_create");
	});

	it("records the first TEAM worker's target session before it starts", () => {
		const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "agent-team.ts"), "utf8");
		expect(source).toContain("sessionFile: isToolkitCliAgent(canonicalName) ? undefined : agentSessionFile");
	});

	it("keeps full worker transcripts out of structured team/chain/pipeline details", () => {
		for (const file of ["agent-team.ts", "agent-chain.ts", "pipeline-team.ts"]) {
			const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", file), "utf8");
			expect(source).toContain("outputPreview");
			expect(source).not.toContain("details.fullOutput");
		}
	});

	it("returns the parent RunContext id from team, chain, and pipeline entry points", () => {
		const root = join(dirname(fileURLToPath(import.meta.url)), "..");
		expect(readFileSync(join(root, "agent-team.ts"), "utf8")).toContain("runId: orchestrationRun.runId");
		expect(readFileSync(join(root, "agent-chain.ts"), "utf8")).toContain("runId: result.runId");
		expect(readFileSync(join(root, "pipeline-team.ts"), "utf8")).toContain("runId: orchestrationRun.runId");
		expect(readFileSync(join(root, "pipeline-team.ts"), "utf8")).toContain("Pipeline dispatch failed:");
		expect(readFileSync(join(root, "pipeline-team.ts"), "utf8")).toContain('reason: "already_dispatched"');
		expect(readFileSync(join(root, "pipeline-team.ts"), "utf8")).toContain("recovery can ask it to advance instead of repeating side effects");
		expect(readFileSync(join(root, "pipeline-team.ts"), "utf8")).toContain("const resumable = snapshot && pipelineConfigs.some");
		expect(readFileSync(join(root, "pipeline-team.ts"), "utf8")).not.toContain("// Wipe pipeline session files");
		const team = readFileSync(join(root, "agent-team.ts"), "utf8");
		expect(team).toContain("const teamSessionNames = new Set");
		expect(team).not.toContain('if (f.endsWith(".json"))');
		expect(team).toContain("resumableTeamSessionNames(journalList(sessDir), sessDir, teamSessionNames)");
		expect(readFileSync(join(root, "lib", "team-session-cleanup.ts"), "utf8")).toContain("entry.status === \"done\"");
		expect(readFileSync(join(root, "agent-chain.ts"), "utf8")).toContain('orchestrationRun.record("chain.step.reused"');
		expect(readFileSync(join(root, "agent-chain.ts"), "utf8")).toContain("originalTask: originalPrompt");
		expect(readFileSync(join(root, "agent-chain.ts"), "utf8")).not.toContain("--append-system-prompt");
		expect(readFileSync(join(root, "agent-chain.ts"), "utf8")).toContain("entry.startedAt >= snapshotUpdatedAt");
		expect(readFileSync(join(root, "lib", "tool-executor-registry.ts"), "utf8")).toContain('"dispatch_team_batch"');
		expect(readFileSync(join(root, "agent-team.ts"), "utf8")).toContain("scheduleResourceWaves(jobs, jobs.length)");
		expect(readFileSync(join(root, "agent-team.ts"), "utf8")).toContain("resultOneLiner(result.fullOutput");
		expect(readFileSync(join(root, "agent-team.ts"), "utf8")).toContain(".slice(0, 8_000)");
		expect(readFileSync(join(root, "agent-team.ts"), "utf8")).toContain('name: "team_batch_recover"');
		expect(readFileSync(join(root, "orchestration-status.ts"), "utf8")).toContain("team_batch_recover");
		expect(readFileSync(join(root, "agent-team.ts"), "utf8")).toContain("projectTeamBatchRecovery(entries, sessionRoot)");
		expect(readFileSync(join(root, "lib/task-gate.ts"), "utf8")).toContain('"subagent_create_batch"');
		expect(readFileSync(join(root, "agent-team.ts"), "utf8")).toContain("parentRun.recordUsage({ totalTokens: tu.totalTokens");
		expect(readFileSync(join(root, "agent-chain.ts"), "utf8")).toContain("parentRun.recordUsage({ totalTokens: su.totalTokens");
		expect(readFileSync(join(root, "pipeline-team.ts"), "utf8")).toContain("parentRun.recordUsage({ totalTokens: pu.totalTokens");
		expect(readFileSync(join(root, "lib", "orchestration-run.ts"), "utf8")).toContain("budgetUsageExceededReason");
		expect(readFileSync(join(root, "lib", "orchestration-run.ts"), "utf8")).toContain("signal: AbortSignal");
		expect(readFileSync(join(root, "lib", "resource-scheduler.ts"), "utf8")).toContain("scheduleResourceWaves");
		expect(readFileSync(join(root, "agent-team.ts"), "utf8")).toContain("resources: Type.Optional");
		expect(readFileSync(join(root, "agent-team.ts"), "utf8")).toContain('"team.batch.wave"');
		expect(readFileSync(join(root, "pipeline-team.ts"), "utf8")).toContain('"pipeline.phase.wave"');
		expect(readFileSync(join(root, "tool-registry.ts"), "utf8")).toContain("inputSchema: tool.parameters");
	});

	it("propagates tool cancellation into TEAM, CHAIN, and PIPELINE workers", () => {
		const root = join(dirname(fileURLToPath(import.meta.url)), "..");
		const team = readFileSync(join(root, "agent-team.ts"), "utf8");
		const chain = readFileSync(join(root, "agent-chain.ts"), "utf8");
		const pipeline = readFileSync(join(root, "pipeline-team.ts"), "utf8");
		expect(team).toContain("runEpoch !== sessionEpoch || !!signal?.aborted");
		expect(chain).toContain("!lifecycle.isCurrent(runEpoch) || !!signal?.aborted");
		expect(pipeline).toContain("isAborted: () => !!signal?.aborted");
	});
	it("makes session switches a cancellation boundary for every orchestration mode", () => {
		const root = join(dirname(fileURLToPath(import.meta.url)), "..");
		const mode = readFileSync(join(root, "mode-cycler.ts"), "utf8");
		const chain = readFileSync(join(root, "agent-chain.ts"), "utf8");
		const pipeline = readFileSync(join(root, "pipeline-team.ts"), "utf8");
		expect(mode).toContain('pi.on("session_switch"');
		expect(mode).toContain('setCoordinationMode("NORMAL", ctx)');
		expect(chain).toContain('pi.on("session_switch"');
		expect(chain).toContain("lifecycle.stopAll()");
		expect(pipeline).toContain('pi.on("session_switch"');
		expect(pipeline).toContain("lifecycle.stopAll()");
	});

	it("closes session-owned viewers on session switch", () => {
		const root = join(dirname(fileURLToPath(import.meta.url)), "..");
		for (const file of [
			"research-viewer.ts", "reports-viewer.ts", "sounds.ts", "spec-viewer.ts",
			"board-viewer.ts", "file-viewer.ts", "completion-report.ts", "plan-viewer.ts",
			"security-report.ts", "cleanup-viewer.ts",
		]) {
			const source = readFileSync(join(root, file), "utf8");
			expect(source).toContain('pi.on("session_switch"');
		}
	});
	it("gates advance_phase on dispatchCount", () => {
		const src = readFileSync(join(__dirname, "..", "pipeline-team.ts"), "utf8");
		expect(src).toContain("phaseRequiresAgentDispatch");
		expect(src).toContain("dispatchCount");
		expect(src).toContain("pipelineSelectLabel");
		expect(src).toContain("__piSetMode");
		expect(src).toContain('pi.on("session_shutdown"');
		expect(src).toContain("__piKillPipelineProc = undefined");
		expect(src).toContain("clearInterval(agent.timer)");
		expect(src).toContain("lifecycle.stopAll()");
	});

	it("hides chain widget outside CHAIN mode", () => {
		const src = readFileSync(join(__dirname, "..", "agent-chain.ts"), "utf8");
		expect(src).toContain("hideChainWidget");
		expect(src).toContain("unwatchMode");
		expect(src).toContain('pi.on("session_shutdown"');
		expect(src).toContain("currentChainTimer");
		expect(src).toContain("Leaving CHAIN is a cancellation boundary");
		expect(src).toContain("lifecycle.stopAll()");
		expect(src).toContain("__piKillChainProc = undefined");
		expect(src).toContain("providers.splice(index, 1)");
		expect(src).toContain("Do not implement, test, or re-verify");
		expect(src).toContain("extractResultBlock");
	});

	it("auto-closes successful Pi herdr panes through the shared runtime", () => {
		const src = readFileSync(join(__dirname, "..", "lib", "dispatch-runtime.ts"), "utf8");
		expect(src).toContain("scheduleHerdrPaneClose");
		expect(src).toContain('herdrPaneAutoCloseMs("success")');
	});

	it("polls session jsonl for TEAM toolCount while running", () => {
		const src = readFileSync(join(__dirname, "..", "agent-team.ts"), "utf8");
		expect(src).toContain("countSessionToolCalls(sessionPath)");
		expect(src).toContain("countSessionToolCalls(agentSessionFile)");
	});

	it("requires TEAM scout-first recon for unfamiliar or multi-file work", () => {
		const src = readFileSync(join(__dirname, "..", "agent-team.ts"), "utf8");
		expect(src).toContain("When the task involves unfamiliar code, multiple files, a call chain, or existing patterns, dispatch the scout first");
		expect(src).toContain("For a small task with known files and symbols, you may dispatch the appropriate specialist directly");
	});
});
