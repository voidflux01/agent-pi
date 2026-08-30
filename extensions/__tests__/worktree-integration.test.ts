import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createBuilderWorktree, applyWorktreeDiff } from "../lib/worktree.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

describe("worktree integration", () => {
  it("applies tracked and untracked worker changes", () => {
    const repo = mkdtempSync(join("/tmp", "pi-worktree-"));
    git(repo, "init", "-q"); git(repo, "config", "user.email", "test@example.com"); git(repo, "config", "user.name", "Test");
    writeFileSync(join(repo, "tracked.txt"), "base\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "base");
    const ref = createBuilderWorktree(repo, join(repo, ".worktrees"), "worker-1");
    writeFileSync(join(ref.path, "tracked.txt"), "changed\n");
    mkdirSync(join(ref.path, "new")); writeFileSync(join(ref.path, "new", "file.txt"), "new\n");
    applyWorktreeDiff(ref, repo);
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("changed\n");
    expect(readFileSync(join(repo, "new", "file.txt"), "utf8")).toBe("new\n");
  });
});
