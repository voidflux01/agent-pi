import { describe, expect, it } from "vitest";
import { resumableTeamSessionNames } from "../lib/team-session-cleanup.ts";
import type { TaskJournalEntry } from "../lib/agent-task-journal.ts";

function entry(overrides: Partial<TaskJournalEntry>): TaskJournalEntry {
	return {
		version: 1, id: "run", kind: "team", agent: "Planner", task: "task",
		status: "error", startedAt: 1, updatedAt: 1,
		...overrides,
	};
}

describe("TEAM session cleanup policy", () => {
	const root = "/workspace/.pi/agent-sessions";
	const names = new Set(["planner.json", "builder.json"]);
	const exists = (path: string) => path === `${root}/planner.json` || path === `${root}/builder.json`;

	it("retains the latest unfinished in-root TEAM session", () => {
		expect(resumableTeamSessionNames([
			entry({ sessionFile: `${root}/planner.json` }),
		], root, names, exists)).toEqual(new Set(["planner.json"]));
	});

	it("does not retain completed, out-of-root, or non-TEAM sessions", () => {
		expect(resumableTeamSessionNames([
			entry({ status: "done", sessionFile: `${root}/planner.json`, updatedAt: 3 }),
			entry({ agent: "Builder", sessionFile: "/tmp/builder.json" }),
			entry({ kind: "pipeline", agent: "Planner", sessionFile: `${root}/planner.json` }),
		], root, names, exists)).toEqual(new Set());
	});

	it("uses the newest row for each role", () => {
		expect(resumableTeamSessionNames([
			entry({ sessionFile: `${root}/planner.json`, updatedAt: 4 }),
			entry({ sessionFile: `${root}/planner.json`, status: "done", updatedAt: 5 }),
		], root, names, exists)).toEqual(new Set());
	});
});
