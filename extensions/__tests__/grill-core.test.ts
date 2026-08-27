import { describe, expect, it, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	armGrillSession,
	grillStatePath,
	readGrillState,
	recordGrillTurn,
	renderGrillMarkdown,
	saveGrillResults,
} from "../lib/grill-core.ts";

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "grill-"));
});

describe("grill-core", () => {
	it("arms a session with plan and persists state", () => {
		const st = armGrillSession(cwd, "# Plan" + String.fromCharCode(10) + "- [ ] build thing", ".context/todo.md");
		expect(st.turns.length).toBe(0);
		expect(st.plan).toContain("build thing");
		expect(existsSync(grillStatePath(cwd))).toBe(true);
		const disk = readGrillState(cwd);
		expect(disk?.sourcePlanFile).toBe(".context/todo.md");
	});

	it("re-arming keeps recorded turns but refreshes the plan text", () => {
		armGrillSession(cwd, "plan v1");
		recordGrillTurn(cwd, { question: "Q1?", recommendedAnswer: "A1", userAnswer: "user says A1", decisionStatus: "resolved" });
		armGrillSession(cwd, "plan v2 (edited)");
		const st = readGrillState(cwd)!;
		expect(st.turns.length).toBe(1);
		expect(st.plan).toContain("plan v2");
	});

	it("rejects resolved turns without an explicit userAnswer", () => {
		armGrillSession(cwd, "p");
		const res = recordGrillTurn(cwd, { question: "Q?", recommendedAnswer: "R", decisionStatus: "resolved" });
		expect(res.ok).toBe(false);
		const okRes = recordGrillTurn(cwd, { question: "Q?", recommendedAnswer: "R", decisionStatus: "open" });
		expect(okRes.ok).toBe(true);
	});

	it("renders markdown with turns and extras, refuses paths outside cwd", () => {
		armGrillSession(cwd, "the plan body");
		recordGrillTurn(cwd, { question: "DB choice?", recommendedAnswer: "sqlite", userAnswer: "postgres", decisionStatus: "resolved", notes: "existing infra" });
		const st = readGrillState(cwd)!;
		const md = renderGrillMarkdown(st, { agreedDecisions: ["use postgres"], openRisks: ["migration needed"], nextDecisionNeeded: "none" });
		expect(md).toContain("# Grill Me Results");
		expect(md).toContain("### 1. DB choice?");
		expect(md).toContain("**User answer:** postgres");
		expect(md).toContain("- use postgres");
		const bad = saveGrillResults(cwd, {}, "../evil.md");
		expect((bad as any).error).toContain("outside project directory");
	});

	it("save writes markdown file to cwd by default", () => {
		armGrillSession(cwd, "plan");
		const res = saveGrillResults(cwd, { summary: "shared understanding" });
		expect(readFileSync((res as any).path, "utf8")).toContain("## Shared Understanding");
	});
});
