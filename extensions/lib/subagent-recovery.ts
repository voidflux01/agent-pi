// ABOUTME: Small, testable contracts for reopening persisted standalone subagent sessions.
// ABOUTME: Keeps resume flag construction separate from the widget and dispatch lifecycle.

import { existsSync } from "node:fs";

/** Insert Pi's continuation flag immediately before the new prompt. */
export function withSessionResume(argv: string[], sessionFile: string, exists: (path: string) => boolean = existsSync): string[] {
	if (!exists(sessionFile) || argv.length === 0) return [...argv];
	const promptIndex = argv.length - 1;
	return [...argv.slice(0, promptIndex), "-c", argv[promptIndex]];
}
