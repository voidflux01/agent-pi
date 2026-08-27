// ABOUTME: Shared path containment checks for browser viewers and file operations.
// ABOUTME: Handles sibling-prefix and parent-directory edge cases safely.

import { isAbsolute, relative, resolve, sep } from "node:path";

/** Return true when candidate is root itself or a descendant of root. */
export function isWithinDirectory(root: string, candidate: string): boolean {
	const rel = relative(resolve(root), resolve(candidate));
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
