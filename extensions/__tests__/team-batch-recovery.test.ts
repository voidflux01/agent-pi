import { describe, expect, test } from "bun:test";
import { projectTeamBatchRecovery } from "../lib/team-batch-recovery.ts";

const base = (overrides: Record<string, unknown> = {}) => ({
	version: 1 as const, id: "builder-1", kind: "team" as const, agent: "builder", task: "finish the task",
	status: "error" as const, startedAt: 1, updatedAt: 2, ...overrides,
});

describe("TEAM batch recovery projection", () => {
	test("only resumes unfinished sessions inside the session root", () => {
		const root = "/tmp/pi-team-recovery";
		const candidates = projectTeamBatchRecovery([
			base({ id: "unfinished", sessionFile: `${root}/builder.jsonl` }),
			base({ id: "done", status: "done", sessionFile: `${root}/done.jsonl` }),
			base({ id: "outside", sessionFile: "/tmp/other.jsonl" }),
			base({ id: "missing", sessionFile: `${root}/missing.jsonl` }),
		], root, (path) => path.endsWith("builder.jsonl") || path.endsWith("done.jsonl"));

		expect(candidates).toMatchObject([
			{ id: "unfinished", canResume: true, sessionFile: `${root}/builder.jsonl` },
			{ id: "done", canResume: false },
			{ id: "outside", canResume: false },
			{ id: "missing", canResume: false },
		]);
	});

	test("bounds task text before exposing recovery context", () => {
		const [candidate] = projectTeamBatchRecovery([base({ sessionFile: "/tmp/root/a.jsonl", task: "x".repeat(1_000) })], "/tmp/root", () => true);
		expect(candidate.task).toHaveLength(240);
	});
});
