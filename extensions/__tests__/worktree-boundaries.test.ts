import { describe, expect, it } from "vitest";
import { createBuilderWorktree } from "../lib/worktree.ts";

describe("worktree boundaries", () => {
  it("rejects traversal and absolute identifiers before git", () => {
    expect(() => createBuilderWorktree(process.cwd(), "/tmp/worktrees", "../escape")).toThrow();
    expect(() => createBuilderWorktree(process.cwd(), "/tmp/worktrees", "/absolute")).toThrow();
  });
});
