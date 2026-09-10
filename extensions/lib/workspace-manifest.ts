// ABOUTME: Fast workspace gate for verification — a git-state fingerprint, not a
// ABOUTME: content hash. Binds the contract fingerprint to index object ids
// ABOUTME: (git ls-files -s) plus git status --porcelain state (staged/dirty/
// ABOUTME: untracked names) and the repo's declared exclusions. No per-file
// ABOUTME: reads: O(index + stat walk). All the gate must answer is "did the
// ABOUTME: workspace change since the receipt?", and that never needs reading
// ABOUTME: every byte of the tree.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, sep } from "node:path";

export interface WorkspaceFileEntry {
	path: string; // repo-relative, posix
	oid: string;  // git index object id — content identity of staged/committed state
}

export interface WorkspaceManifest {
	version: 2;
	contractFingerprint: string;
	files: WorkspaceFileEntry[];
	staged: string[];
	untracked: string[];
	/** Raw `git status --porcelain` rows that survived the filters. */
	dirty: string[];
	/** Exclusion rules the repository declared in .pi/manifest-ignore. */
	declared: string[];
	hash: string;
}

// Only agent-pi's own bookkeeping is excluded by name. Build output and caches
// are language-specific, so they are never guessed here: a repository either
// ignores them (.gitignore, which git already honors) or declares them in
// .pi/manifest-ignore. Anything else that a verification command regenerates
// would silently widen every receipt, which is worse than a named failure.
export const MANIFEST_EXCLUDED_DIRS = new Set([".git", ".pi", "node_modules", ".context", "context-os"]);

/** Path of the per-repository exclusion declaration, read from the audited repo. */
export const MANIFEST_IGNORE_FILE = join(".pi", "manifest-ignore");

/**
 * Read the audited repository's own exclusion declarations. One rule per line:
 * a bare name matches that path segment at any depth (`target`), a rule
 * containing `/` matches a repo-relative prefix (`build/generated`). `#` comments.
 */
export function readManifestIgnore(cwd: string): string[] {
	try {
		return readFileSync(join(cwd, MANIFEST_IGNORE_FILE), "utf8")
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(line => line && !line.startsWith("#"));
	} catch {
		return [];
	}
}

function included(path: string, declared: string[]): boolean {
	const parts = path.split(sep).filter(Boolean);
	if (parts.some(part => MANIFEST_EXCLUDED_DIRS.has(part))) return false;
	const posix = parts.join("/");
	return !declared.some(rule => rule.includes("/") ? posix === rule || posix.startsWith(`${rule}/`) : parts.includes(rule));
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function git(cwd: string, args: string[]): string[] {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
			.split("\n")
			.filter(Boolean);
	} catch {
		return [];
	}
}

/** Path part of a porcelain row ("XY path", renames "R  old -> new"). */
function porcelainPath(line: string): string {
	return line.slice(3);
}

/** Build a git-state fingerprint of the workspace at cwd, bound to a contract
 *  fingerprint. Staged/committed content identity comes from the index object
 *  ids; worktree edits, deletions and untracked files surface as porcelain
 *  rows. ponytail: identity by state row, not by content — editing an
 *  already-dirty or untracked file without changing its row (or its index oid)
 *  does not invalidate a receipt. Add per-dirty-file `git hash-object` reads
 *  if content-level identity is ever required. */
export function buildWorkspaceManifest(cwd: string, contractFingerprint: string): WorkspaceManifest {
	const declared = readManifestIgnore(cwd);
	const keep = (path: string) => included(path, declared);
	const files = git(cwd, ["ls-files", "--stage"])
		.map(line => {
			const [meta, path = ""] = line.split("\t", 2);
			return { path, oid: meta.split(" ", 3)[1] || "" };
		})
		.filter(entry => entry.path && entry.oid && keep(entry.path));
	const porcelain = git(cwd, ["status", "--porcelain", "--untracked-files=all"]).filter(line => keep(porcelainPath(line)));
	const staged: string[] = [];
	const untracked: string[] = [];
	for (const line of porcelain) {
		const xy = line.slice(0, 2);
		if (xy === "??") untracked.push(porcelainPath(line));
		else if (xy[0] !== " " && xy[0] !== "?") staged.push(porcelainPath(line));
	}

	const serialized = JSON.stringify({
		version: 2,
		contractFingerprint,
		staged: [...staged].sort(),
		untracked: [...untracked].sort(),
		dirty: [...porcelain].sort(),
		// Declared policy is part of the binding: widening what a receipt ignores
		// must invalidate it rather than silently extend its coverage claim.
		declared: [...declared].sort(),
		files: files.map(f => `${f.path}:${f.oid}`).join("\n"),
	});
	return {
		version: 2,
		contractFingerprint,
		files,
		staged: [...staged].sort(),
		untracked: [...untracked].sort(),
		dirty: [...porcelain].sort(),
		declared: [...declared].sort(),
		hash: sha256(serialized),
	};
}

function dirtyLabel(line: string): string {
	const xy = line.slice(0, 2);
	const path = porcelainPath(line);
	if (xy === "??") return `created ${path}`;
	if (xy.includes("D")) return `deleted ${path}`;
	if (xy.includes("R")) return `renamed ${path}`;
	return `modified ${path}`;
}

/** State whose fingerprint differs between two manifests: index object-id
 *  changes (created/modified/deleted), newly-dirty porcelain rows, and
 *  declared exclusion-rule changes (declared/undeclared <rule>). */
export function manifestDelta(before: WorkspaceManifest, after: WorkspaceManifest): string[] {
	const changed = new Set<string>();
	const beforeMap = new Map(before.files.map(entry => [entry.path, entry.oid]));
	const afterMap = new Map(after.files.map(entry => [entry.path, entry.oid]));
	for (const [path, oid] of beforeMap) {
		if (afterMap.get(path) === oid) continue;
		changed.add(afterMap.has(path) ? `modified ${path}` : `deleted ${path}`);
	}
	for (const path of afterMap.keys()) if (!beforeMap.has(path)) changed.add(`created ${path}`);
	const beforeDirty = new Set(before.dirty);
	for (const line of after.dirty) if (!beforeDirty.has(line)) changed.add(dirtyLabel(line));
	const beforeDeclared = new Set(before.declared);
	for (const rule of after.declared) if (!beforeDeclared.has(rule)) changed.add(`declared ${rule}`);
	for (const rule of before.declared) if (!beforeDeclared.has(rule)) changed.add(`undeclared ${rule}`);
	return [...changed].sort();
}

/** Deterministic label for receipts: manifest hash over the whole workspace state. */