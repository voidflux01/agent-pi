// ABOUTME: Tests for the PLAN/SPEC implementation gate.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	approvalStateForMode,
	decideApprovalGate,
	isReadOnlyBash,
	isPlanningArtifact,
	markPlanApproved,
	markSpecApproved,
	resetApprovalForMode,
	resetApprovals,
	toolPath,
} from "../lib/approval-gate.ts";
import { coordinationState } from "../lib/coordination-state.ts";
import { registerDiscoveredCapability, resetCapabilitiesForTests } from "../lib/capability-registry.ts";

describe("isPlanningArtifact", () => {
	const cwd = "/tmp/app";

	it("allows PLAN files under the project .context root", () => {
		expect(isPlanningArtifact("PLAN", ".context/todo.md")).toBe(true);
		expect(isPlanningArtifact("PLAN", ".context/todo.md", cwd)).toBe(true);
		expect(isPlanningArtifact("PLAN", "/tmp/app/.context/todo.md", cwd)).toBe(true);
	});

	it("rejects PLAN nested or escaped lookalikes", () => {
		expect(isPlanningArtifact("PLAN", "src/index.ts", cwd)).toBe(false);
		expect(isPlanningArtifact("PLAN", "src/.context/evil.ts", cwd)).toBe(false);
		expect(isPlanningArtifact("PLAN", "src/.context-backup/x.ts", cwd)).toBe(false);
		expect(isPlanningArtifact("PLAN", "../.context/todo.md", cwd)).toBe(false);
		expect(isPlanningArtifact("PLAN", "/tmp/app/.context/todo.md")).toBe(false);
	});

	it("allows SPEC files under the project context-os root", () => {
		expect(isPlanningArtifact("SPEC", "context-os/specs/2026-08-29-share/planning/questions.md")).toBe(true);
		expect(isPlanningArtifact("SPEC", "context-os/specs/x/planning/questions.md", cwd)).toBe(true);
	});

	it("rejects SPEC nested or escaped lookalikes", () => {
		expect(isPlanningArtifact("SPEC", "src/share.ts", cwd)).toBe(false);
		expect(isPlanningArtifact("SPEC", "lib/context-os-utils.ts", cwd)).toBe(false);
		expect(isPlanningArtifact("SPEC", "src/context-os/evil.ts", cwd)).toBe(false);
		expect(isPlanningArtifact("SPEC", "../context-os/spec.md", cwd)).toBe(false);
	});
});

describe("toolPath", () => {
	it("reads path, file, or file_path", () => {
		expect(toolPath({ path: "src/a.ts" })).toBe("src/a.ts");
		expect(toolPath({ file: "src/a.ts" })).toBe("src/a.ts");
		expect(toolPath({ file_path: ".context/todo.md" })).toBe(".context/todo.md");
	});
});

describe("decideApprovalGate", () => {
	it("does not gate NORMAL", () => {
		expect(decideApprovalGate({ mode: "NORMAL", approved: false, toolName: "write", args: { path: "src/a.ts" } })).toEqual({ block: false });
	});

	it("allows PLAN planning writes before approval", () => {
		expect(decideApprovalGate({
			mode: "PLAN", approved: false, toolName: "write", args: { path: ".context/todo.md" },
		})).toEqual({ block: false });
	});

	it("blocks PLAN implementation writes before approval", () => {
		const d = decideApprovalGate({
			mode: "PLAN", approved: false, toolName: "write", args: { path: "src/share.ts" },
		});
		expect(d.block).toBe(true);
		expect(d.reason).toContain("show_plan");
	});

	it("blocks PLAN bash before approval", () => {
		expect(decideApprovalGate({
			mode: "PLAN", approved: false, toolName: "bash", args: { command: "bun src/index.ts" },
		}).block).toBe(true);
	});

	it("blocks discovered non-read-only MCP tools before PLAN approval", () => {
		registerDiscoveredCapability({ name: "mcp__repo__apply_patch", description: "Apply a patch to workspace files" });
		const decision = decideApprovalGate({ mode: "PLAN", approved: false, toolName: "mcp__repo__apply_patch" });
		expect(decision.block).toBe(true);
		expect(decision.reason).toContain("show_plan");
		resetCapabilitiesForTests();
	});

	it("allows read-only bash before PLAN/SPEC approval", () => {
		for (const command of ["date +%F", "wc -l todo.mjs", "pwd", "uname -s"]) {
			expect(decideApprovalGate({
				mode: "PLAN", approved: false, toolName: "bash", args: { command },
			}).block).toBe(false);
			expect(decideApprovalGate({
				mode: "SPEC", approved: false, toolName: "bash", args: { command },
			}).block).toBe(false);
		}
	});

	it("allows composed read-only bash with safe stderr suppression", () => {
		const command = 'cd /tmp/app && ls .pi 2>/dev/null; grep -rln "foo bar" .context 2>/dev/null | head && git log --oneline -5 && git status --short 2>/dev/null';
		expect(isReadOnlyBash({ command })).toBe(true);
		expect(decideApprovalGate({ mode: "PLAN", approved: false, toolName: "bash", args: { command } }).block).toBe(false);
	});

	it("allows narrowly-scoped read-only Git inspection", () => {
		for (const command of ["git log --oneline -5", "git status --short", "git status --porcelain -uno"]) {
			expect(isReadOnlyBash({ command })).toBe(true);
			expect(decideApprovalGate({ mode: "PLAN", approved: false, toolName: "bash", args: { command } }).block).toBe(false);
		}
	});

	it("rejects shell expansion, writes, and dangerous find predicates", () => {
		for (const command of [
			"grep foo > result.txt",
			"grep foo $FILE",
			"find . -exec rm {}",
			"find . -delete",
			"ls &",
			"git commit -am done",
			"git config --list",
			"git -C /tmp/other status",
			"git log --format=%H",
		]) expect(isReadOnlyBash({ command })).toBe(false);
	});

	it("still blocks mutating bash before approval", () => {
		expect(decideApprovalGate({
			mode: "SPEC", approved: false, toolName: "bash", args: { command: "date +%F && rm todos.json" },
		}).block).toBe(true);
		expect(decideApprovalGate({
			mode: "PLAN", approved: false, toolName: "bash", args: { command: "echo hi > src/a.ts" },
		}).block).toBe(true);
	});

	it("allows read, tasks, ask_user, show_plan, and scout before approval", () => {
		for (const toolName of ["read", "ls", "grep", "tasks", "ask_user", "show_plan", "set_mode"]) {
			expect(decideApprovalGate({ mode: "PLAN", approved: false, toolName }).block).toBe(false);
		}
		expect(decideApprovalGate({
			mode: "PLAN", approved: false, toolName: "subagent_create", args: { name: "scout", task: "look" },
		}).block).toBe(false);
		expect(decideApprovalGate({ mode: "PLAN", approved: false, toolName: "compose_exec", args: { steps: [] } }).block).toBe(true);
	});

	it("blocks a non-scout subagent before approval", () => {
		expect(decideApprovalGate({
			mode: "PLAN", approved: false, toolName: "subagent_create", args: { name: "builder", task: "code" },
		}).block).toBe(true);
	});

	it("allows PLAN implementation after approval", () => {
		expect(decideApprovalGate({
			mode: "PLAN", approved: true, toolName: "write", args: { path: "src/share.ts" },
		})).toEqual({ block: false });
		expect(decideApprovalGate({
			mode: "PLAN", approved: true, toolName: "bash", args: { command: "bun test" },
		})).toEqual({ block: false });
	});

	it("allows SPEC context-os writes and blocks src writes", () => {
		expect(decideApprovalGate({
			mode: "SPEC", approved: false, toolName: "write",
			args: { path: "context-os/specs/2026-08-29-x/planning/initialization.md" },
		})).toEqual({ block: false });
		const d = decideApprovalGate({
			mode: "SPEC", approved: false, toolName: "edit", args: { path: "src/index.ts" },
		});
		expect(d.block).toBe(true);
		expect(d.reason).toContain("show_spec");
	});

	it("does not block show_spec or show_plan questions before SPEC approval", () => {
		expect(decideApprovalGate({ mode: "SPEC", approved: false, toolName: "show_spec" }).block).toBe(false);
		expect(decideApprovalGate({
			mode: "SPEC", approved: false, toolName: "show_plan", args: { file_path: "planning/questions.md", mode: "questions" },
		}).block).toBe(false);
	});

	it("blocks call_tool that proxies implementation writes", () => {
		const d = decideApprovalGate({
			mode: "PLAN",
			approved: false,
			toolName: "call_tool",
			args: { tool_name: "write", arguments: { path: "src/a.ts", content: "x" } },
			cwd: "/tmp/app",
		});
		expect(d.block).toBe(true);
		expect(d.reason).toContain("show_plan");
	});

	it("allows call_tool that proxies planning writes or reads", () => {
		expect(decideApprovalGate({
			mode: "PLAN",
			approved: false,
			toolName: "call_tool",
			args: { tool_name: "write", arguments: { path: ".context/todo.md", content: "# Plan" } },
			cwd: "/tmp/app",
		}).block).toBe(false);
		expect(decideApprovalGate({
			mode: "PLAN",
			approved: false,
			toolName: "call_tool",
			args: { tool_name: "read", arguments: { path: "src/a.ts" } },
			cwd: "/tmp/app",
		}).block).toBe(false);
	});

	it("blocks nested call_tool and call_tool without a target", () => {
		expect(decideApprovalGate({
			mode: "PLAN", approved: false, toolName: "call_tool", args: {},
		}).block).toBe(true);
		expect(decideApprovalGate({
			mode: "PLAN",
			approved: false,
			toolName: "call_tool",
			args: { tool_name: "call_tool", arguments: { tool_name: "write", arguments: { path: "src/a.ts" } } },
		}).block).toBe(true);
	});
});

describe("approval session flags", () => {
	beforeEach(() => resetApprovals());

	it("starts locked and unlocks PLAN after markPlanApproved", () => {
		expect(approvalStateForMode("PLAN")).toBe(false);
		markPlanApproved();
		expect(approvalStateForMode("PLAN")).toBe(true);
		expect(approvalStateForMode("SPEC")).toBe(false);
	});

	it("clears PLAN approval when re-entering PLAN", () => {
		markPlanApproved();
		resetApprovalForMode("PLAN");
		expect(approvalStateForMode("PLAN")).toBe(false);
	});

	it("unlocks SPEC independently", () => {
		markSpecApproved();
		expect(approvalStateForMode("SPEC")).toBe(true);
		expect(approvalStateForMode("PLAN")).toBe(false);
	});

	it("stores flags on the shared coordination bus", () => {
		markPlanApproved();
		expect(coordinationState().planApproved).toBe(true);
		markSpecApproved();
		expect(coordinationState().specApproved).toBe(true);
		resetApprovals();
		expect(coordinationState().planApproved).toBe(false);
		expect(coordinationState().specApproved).toBe(false);
	});
});


describe("approval bindings", () => {
	beforeEach(() => resetApprovals());

	it("invalidates PLAN approval when the approved file changes", () => {
		const root = mkdtempSync(join(tmpdir(), "approval-plan-"));
		const file = join(root, "todo.md");
		writeFileSync(file, "original");
		markPlanApproved(file);
		expect(approvalStateForMode("PLAN")).toBe(true);
		writeFileSync(file, "changed");
		expect(approvalStateForMode("PLAN")).toBe(false);
	});

	it("binds PLAN approval to reviewed markdown, not a later disk rewrite", () => {
		const root = mkdtempSync(join(tmpdir(), "approval-plan-md-"));
		const file = join(root, "todo.md");
		writeFileSync(file, "reviewed");
		markPlanApproved(file, "reviewed");
		expect(approvalStateForMode("PLAN")).toBe(true);
		writeFileSync(file, "sneak");
		expect(approvalStateForMode("PLAN")).toBe(false);
	});

	it("invalidates SPEC approval when a file is added or changed", () => {
		const root = mkdtempSync(join(tmpdir(), "approval-spec-"));
		writeFileSync(join(root, "spec.md"), "spec");
		markSpecApproved(root);
		expect(approvalStateForMode("SPEC")).toBe(true);
		writeFileSync(join(root, "requirements.md"), "new requirement");
		expect(approvalStateForMode("SPEC")).toBe(false);
	});
});
