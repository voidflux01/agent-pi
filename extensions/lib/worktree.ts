// ABOUTME: Opt-in git worktree lifecycle for parallel builders.
// ABOUTME: Creation is explicit and cleanup is never automatic, preserving user changes for review.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";

export interface WorktreeRef { id: string; path: string; branch: string; base: string; }
function valid(value: string): boolean { return /^[A-Za-z0-9._/-]+$/.test(value) && !value.includes("..") && !value.startsWith("/"); }
function git(cwd: string, args: string[]): string { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
export function createBuilderWorktree(cwd: string, rootDir: string, id: string, base = "HEAD"): WorktreeRef {
  if (!valid(id) || !valid(base)) throw new Error("Invalid worktree id or base ref");
  const path = resolve(rootDir, id); if (!path.startsWith(resolve(rootDir) + "/")) throw new Error("Worktree path escapes root");
  mkdirSync(rootDir, { recursive: true });
  if (existsSync(path)) throw new Error(`Worktree already exists: ${path}`);
  const branch = `pi-worker/${id}`;
  git(cwd, ["worktree", "add", "-b", branch, path, base]);
  return { id, path, branch, base };
}
export function worktreeDiff(ref: WorktreeRef): string { return git(ref.path, ["diff", "--no-ext-diff", "--"]); }
export function worktreeStatus(ref: WorktreeRef): string { return git(ref.path, ["status", "--short"]); }


/** Apply a completed worker's tracked diff to the coordinator tree. */
export function applyWorktreeDiff(ref: WorktreeRef, targetCwd: string): void {
  const patch = execFileSync("git", ["diff", "--binary", "--no-ext-diff", "--"], { cwd: ref.path, encoding: "buffer", maxBuffer: 20 * 1024 * 1024 });
  if (patch.length === 0) return;
  const proc = spawnSync("git", ["apply", "--3way", "--whitespace=nowarn", "-"], { cwd: targetCwd, input: patch, stdio: ["pipe", "pipe", "pipe"] });
  if (proc.status !== 0) throw new Error((proc.stderr?.toString() || "worktree diff could not be applied").trim());
  // Tracked diffs do not contain new untracked files. Copy only safe, explicitly
  // reported untracked paths; never copy outside the target repository.
  const status = worktreeStatus(ref);
  for (const line of status.split("\n")) {
    const match = line.match(/^\?\?\s+(.+)$/);
    if (!match || !valid(match[1])) continue;
    const source = resolve(ref.path, match[1]);
    const target = resolve(targetCwd, match[1]);
    if (!target.startsWith(resolve(targetCwd) + "/")) throw new Error("Untracked path escapes target");
    cpSync(source, target, { recursive: true, force: false });
  }
}
