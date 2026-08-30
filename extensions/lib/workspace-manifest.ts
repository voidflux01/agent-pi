// ABOUTME: Full workspace manifest for verification — every tracked, staged, and
// ABOUTME: untracked file's content hash, plus the contract fingerprint. This
// ABOUTME: replaces git-diff-only hashing so staged/untracked/committed content
// ABOUTME: cannot slip past the receipt binding.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface WorkspaceFileEntry {
	path: string; // repo-relative, posix
	size: number;
	hash: string;
}

export interface WorkspaceManifest {
	version: 1;
	contractFingerprint: string;
	files: WorkspaceFileEntry[];
	/** Files staged in the index (git diff --cached --name-only). */
	staged: string[];
	/** Untracked-and-not-ignored files (git ls-files --others --exclude-standard). */
	untracked: string[];
	hash: string;
}

export const MANIFEST_EXCLUDED_DIRS = new Set([".git", ".pi", "node_modules", ".context", "context-os"]);

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

function included(path: string): boolean {
	const parts = path.split(sep).filter(Boolean);
	return !parts.some(part => MANIFEST_EXCLUDED_DIRS.has(part));
}

function safeEntry(cwd: string, root: string, rel: string): WorkspaceFileEntry | undefined {
	if (!rel || isAbsolute(rel)) return undefined;
	const absolute = resolve(cwd, rel);
	if (!absolute.startsWith(resolve(root) + sep) && absolute !== resolve(root)) return undefined;
	if (!existsSync(absolute)) return undefined;
	let stat;
	try { stat = statSync(absolute); } catch { return undefined; }
	try {
		if (lstatSync(absolute).isSymbolicLink()) {
			const target = readlinkSync(absolute);
			return { path: rel.split(sep).join("/"), size: target.length, hash: sha256(`symlink:${target}`) };
		}
	} catch { return undefined; }
	if (!stat.isFile()) return undefined;
	let content = "";
	try { content = readFileSync(absolute, "utf8"); } catch { return undefined; }
	return { path: rel.split(sep).join("/"), size: stat.size, hash: sha256(content) };
}

/** Build a full manifest of the workspace at cwd, bound to a contract fingerprint. */
export function buildWorkspaceManifest(cwd: string, contractFingerprint: string): WorkspaceManifest {
	const root = resolve(cwd);
	// Tracked (index + worktree) and untracked-not-ignored files.
	// Reading worktree content covers staged and unstaged state together.
	const tracked = git(cwd, ["ls-files", "--cached"]).filter(included);
	const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"]).filter(included);
	const staged = git(cwd, ["diff", "--cached", "--name-only"]).filter(included);

	const allPaths = [...new Set([...tracked, ...untracked])].sort();
	const files: WorkspaceFileEntry[] = [];
	for (const rel of allPaths) {
		const entry = safeEntry(cwd, root, rel);
		if (entry) files.push(entry);
	}

	const serialized = JSON.stringify({
		version: 1,
		contractFingerprint,
		staged: [...staged].sort(),
		untracked: [...untracked].sort(),
		files: files.map(f => `${f.path}:${f.size}:${f.hash}`).join("\n"),
	});
	return {
		version: 1,
		contractFingerprint,
		files,
		staged: staged.sort(),
		untracked: untracked.sort(),
		hash: sha256(serialized),
	};
}

/** Deterministic label for receipts: manifest hash over the whole workspace state. */
export function manifestLabel(manifest: WorkspaceManifest): string {
	return `${manifest.hash.slice(0, 16)}·${manifest.files.length}f`;
}
