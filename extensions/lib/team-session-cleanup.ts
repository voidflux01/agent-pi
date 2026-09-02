// ABOUTME: Pure policy for retaining unfinished TEAM role sessions at startup.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TaskJournalEntry } from "./agent-task-journal.ts";

export function resumableTeamSessionNames(
	entries: TaskJournalEntry[],
	sessionRoot: string,
	teamSessionNames: Set<string>,
	fileExists: (path: string) => boolean = existsSync,
): Set<string> {
	const root = resolve(sessionRoot);
	const latestByAgent = new Map<string, TaskJournalEntry>();
	for (const entry of entries) {
		if (entry.kind !== "team") continue;
		const key = entry.agent.toLowerCase().replace(/\s+/g, "-");
		const previous = latestByAgent.get(key);
		if (!previous || entry.updatedAt >= previous.updatedAt) latestByAgent.set(key, entry);
	}

	const resumable = new Set<string>();
	for (const [key, entry] of latestByAgent) {
		const fileName = `${key}.json`;
		if (!teamSessionNames.has(fileName) || entry.status === "done") continue;
		const expected = join(root, fileName);
		const recorded = entry.sessionFile ? resolve(entry.sessionFile) : "";
		if (recorded === expected && fileExists(expected)) resumable.add(fileName);
	}
	return resumable;
}
