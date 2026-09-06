import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contextDrift, inspectProjectContext } from "../lib/workflow-context.ts";

function project(scripts: Record<string, string>, withRules = false): string {
	const cwd = mkdtempSync(join(tmpdir(), "agent-pi-contextlib-"));
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts }));
	if (withRules) { writeFileSync(join(cwd, "AGENTS.md"), "rule\n"); writeFileSync(join(cwd, "CLAUDE.md"), "rule\n"); }
	mkdirSync(join(cwd, "src"));
	return cwd;
}

describe("workflow context", () => {
	test("draft lists declared commands without executing them and marks human confirmation", () => {
		const first = inspectProjectContext(project({ test: "npm test", build: "tsc", "bad name!": "x" }));
		expect(first.draft).toContain("- npm run test");
		expect(first.draft).toContain("not executed or verified");
		expect(first.draft).toContain("Human confirmation required");
		expect(first.snapshot.scripts["bad name!"]).toBeUndefined();
	});

	test("flags AGENTS/CLAUDE coexistence instead of inventing precedence", () => {
		const inspected = inspectProjectContext(project({ test: "npm test" }, true));
		expect(inspected.conflicts).toHaveLength(1);
		expect(inspected.conflicts[0]).toContain("never invent a new precedence");
	});

	test("drift detects command, file and directory changes with sources", () => {
		const cwd = project({ test: "npm test" });
		mkdirSync(join(cwd, "docs"));
		const before = inspectProjectContext(cwd).snapshot;
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "npm run check" } }));
		const after = inspectProjectContext(cwd).snapshot;
		const drift = contextDrift(before, after);
		expect(drift.changedCommands).toContain("test");
		expect(drift.note).toContain("No user rules were changed");
		expect(() => contextDrift({ schema_version: 2 } as any, after)).toThrow("Invalid context snapshot");
	});
});
