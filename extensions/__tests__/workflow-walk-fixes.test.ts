// ABOUTME: Guards the chain/team/pipeline walk-through fixes: RESULT one-liners,
// ABOUTME: pipeline advance gates, default team, and select labels.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resultOneLiner } from "../lib/agent-result-contract.ts";
import { phaseRequiresAgentDispatch, pipelineSelectLabel, type PipelineConfig } from "../lib/parse-pipeline-yaml.ts";
import { defaultTeamName } from "../agent-team.ts";
import { ORCHESTRATED_TASK_PROMPT } from "../lib/mode-prompts.ts";

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
	it("tells the parent not to re-run child verification", () => {
		expect(ORCHESTRATED_TASK_PROMPT).toContain("treat its ## RESULT as the report");
		expect(ORCHESTRATED_TASK_PROMPT).toContain("Do not re-run its verification");
		expect(ORCHESTRATED_TASK_PROMPT).toContain("no bash, python");
		expect(ORCHESTRATED_TASK_PROMPT).toContain("do not claim you re-verified");
	});
});

describe("source wiring", () => {
	it("gates advance_phase on dispatchCount", () => {
		const src = readFileSync(join(__dirname, "..", "pipeline-team.ts"), "utf8");
		expect(src).toContain("phaseRequiresAgentDispatch");
		expect(src).toContain("dispatchCount");
		expect(src).toContain("pipelineSelectLabel");
		expect(src).toContain("__piSetMode");
	});

	it("hides chain widget outside CHAIN mode", () => {
		const src = readFileSync(join(__dirname, "..", "agent-chain.ts"), "utf8");
		expect(src).toContain("hideChainWidget");
		expect(src).toContain("unwatchMode");
		expect(src).toContain("Do not implement, test, or re-verify");
		expect(src).toContain("extractResultBlock");
	});

	it("closes Pi herdr panes after success/error linger", () => {
		const src = readFileSync(join(__dirname, "..", "lib", "dispatch-runtime.ts"), "utf8");
		expect(src).toContain("scheduleHerdrPaneClose");
	});

	it("polls session jsonl for TEAM toolCount while running", () => {
		const src = readFileSync(join(__dirname, "..", "agent-team.ts"), "utf8");
		expect(src).toContain("countSessionToolCalls(sessionPath)");
		expect(src).toContain("countSessionToolCalls(agentSessionFile)");
	});
});
