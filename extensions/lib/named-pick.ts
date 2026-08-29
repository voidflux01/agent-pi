// ABOUTME: Resolve a slash-command argument to a named config (chain, pipeline, team).

/** Pick an exact name, then a unique prefix. Empty or ambiguous input returns undefined. */
export function matchNamedOption(names: string[], raw: string): string | undefined {
	const q = raw.trim().toLowerCase();
	if (!q) return undefined;
	const exact = names.find((n) => n.toLowerCase() === q);
	if (exact) return exact;
	const prefixed = names.filter((n) => n.toLowerCase().startsWith(q));
	if (prefixed.length === 1) return prefixed[0];
	return undefined;
}
