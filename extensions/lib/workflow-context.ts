// ABOUTME: Generates evidence-labelled standing context drafts without executing project scripts.
import { readdirSync } from "node:fs";
import { digest, readBounded, redactEvidence } from "./workflow-artifacts.ts";

export interface ContextSnapshot { schema_version: 1; files: Record<string, string>; scripts: Record<string, string>; directories: string[]; }
export function inspectProjectContext(cwd: string): { snapshot: ContextSnapshot; draft: string; conflicts: string[] } {
	const files: Record<string, string> = {};
	const contents: Record<string, string> = {};
	for (const name of ["package.json", "AGENTS.md", "CLAUDE.md", "README.md", "pyproject.toml", "Cargo.toml", "go.mod"]) {
		try { contents[name] = readBounded(cwd, name, 64 * 1024); files[name] = digest(contents[name]); }
		catch (error: any) { if (error.code !== "ENOENT") throw error; }
	}
	let scripts: Record<string, string> = {};
	if (contents["package.json"]) {
		try {
			const manifest = JSON.parse(contents["package.json"]) as { scripts?: unknown };
			scripts = Object.fromEntries(Object.entries(manifest.scripts || {}).filter(([k,v]) => /^[a-zA-Z0-9:_-]+$/.test(k) && typeof v === "string").slice(0, 40)) as Record<string, string>;
		} catch { scripts = {}; }
	}
	const directories = readdirSync(cwd, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith(".") && !["node_modules", "dist", "vendor"].includes(e.name)).map(e => e.name).sort().slice(0, 50);
	const conflicts = contents["AGENTS.md"] && contents["CLAUDE.md"] ? ["AGENTS.md and CLAUDE.md both exist: use Pi's active context/loader order; resolve contradictions with the user, never invent a new precedence."] : [];
	const draft = ["# Project context — review before adopting", "", "## Observed project facts", "",
		...Object.keys(files).map(name => `- Source: ${name}; SHA-256: ${files[name]}`), "", "## Top-level directories", "", ...directories.map(name => `- ${name}/`),
		"", "## Declared commands (not executed or verified)", "", ...Object.keys(scripts).map(name => `- npm run ${name}`),
		"", "## Human confirmation required", "", "- Architecture invariants and data-access boundaries.", "- Which declared checks are safe and required for this task.",
		"- Existing Pi-loaded instructions remain authoritative; this draft does not replace them.", ...conflicts.map(c => `- ${c}`)].join("\n");
	return { snapshot: { schema_version: 1, files, scripts: Object.fromEntries(Object.entries(scripts).map(([k,v]) => [k, redactEvidence(v)])), directories }, draft, conflicts };
}

export function contextDrift(before: ContextSnapshot, after: ContextSnapshot) {
	if (before.schema_version !== 1 || !before.files || !before.scripts || !Array.isArray(before.directories)) throw new Error("Invalid context snapshot");
	return {
		changedFiles: [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].filter(k => before.files[k] !== after.files[k]),
		removedDirectories: before.directories.filter(k => !after.directories.includes(k)),
		changedCommands: [...new Set([...Object.keys(before.scripts), ...Object.keys(after.scripts)])].filter(k => before.scripts[k] !== after.scripts[k]),
		note: "Declared commands were compared, not executed. No user rules were changed.",
	};
}
