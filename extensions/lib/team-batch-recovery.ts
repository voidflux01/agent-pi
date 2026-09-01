// ABOUTME: Pure recovery projection for TEAM batch journal rows.
// ABOUTME: Separates safe candidate classification from the interactive tool.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { TaskJournalEntry } from "./agent-task-journal.ts";

export interface TeamBatchRecoveryCandidate {
	id: string;
	agent: string;
	status: TaskJournalEntry["status"];
	task: string;
	canResume: boolean;
	sessionFile?: string;
}

/**
 * Project journal rows into safe, bounded resume candidates.
 * A worker is resumable only when it is unfinished and its persisted session
 * exists below the current session root. The caller remains responsible for
 * deciding whether to dispatch the candidate.
 */
export function projectTeamBatchRecovery(
	entries: TaskJournalEntry[],
	sessionRoot: string,
	fileExists: (path: string) => boolean = existsSync,
): TeamBatchRecoveryCandidate[] {
	const root = resolve(sessionRoot);
	return entries.map((entry) => {
		const sessionFile = typeof entry.sessionFile === "string" ? resolve(entry.sessionFile) : "";
		const inSessionRoot = sessionFile === root || sessionFile.startsWith(root + "/");
		const canResume = entry.status !== "done" && inSessionRoot && fileExists(sessionFile);
		return {
			id: entry.id,
			agent: entry.agent,
			status: entry.status,
			task: entry.task.slice(0, 240),
			canResume,
			...(canResume ? { sessionFile } : {}),
		};
	});
}
