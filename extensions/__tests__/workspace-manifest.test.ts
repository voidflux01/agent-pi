import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkspaceManifest, manifestDelta } from "../lib/workspace-manifest.ts";

let repo = "";
beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "wm-"));
	const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
	git(["init", "-q"]);
	git(["config", "user.email", "t@t"]);
	git(["config", "user.name", "t"]);
	writeFileSync(join(repo, "base.txt"), "base\n");
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "init"]);
});
afterEach(() => { try { rmSync(repo, { recursive: true, force: true }); } catch { } });

const FINGERPRINT_A = "a".repeat(64);
const FINGERPRINT_B = "b".repeat(64);

describe("workspace manifest", () => {
	it("hashes git state — a working-tree edit changes the manifest hash", () => {
		const before = buildWorkspaceManifest(repo, FINGERPRINT_A);
		writeFileSync(join(repo, "base.txt"), "base changed\n");
		const after = buildWorkspaceManifest(repo, FINGERPRINT_A);
		expect(after.hash).not.toBe(before.hash);
		// A worktree edit moves the file into the dirty state; the index oid is untouched.
		expect(after.files.find(f => f.path === "base.txt")?.oid).toBe(before.files.find(f => f.path === "base.txt")?.oid);
		expect(after.dirty.some(line => line.includes("base.txt"))).toBe(true);
	});

	it("includes untracked files — a new untracked file changes the hash", () => {
		const before = buildWorkspaceManifest(repo, FINGERPRINT_A);
		writeFileSync(join(repo, "new-untracked.ts"), "x\n");
		const after = buildWorkspaceManifest(repo, FINGERPRINT_A);
		expect(after.hash).not.toBe(before.hash);
		expect(after.untracked).toContain("new-untracked.ts");
		// Untracked files have no index oid; they surface as porcelain rows.
		expect(after.files.some(f => f.path === "new-untracked.ts")).toBe(false);
		expect(after.dirty.some(line => line.startsWith("??") && line.includes("new-untracked.ts"))).toBe(true);
	}, 20000);

	it("covers staged AND unstaged content", () => {
		const committed = buildWorkspaceManifest(repo, FINGERPRINT_A);
		writeFileSync(join(repo, "base.txt"), "v1\n");
		execFileSync("git", ["add", "base.txt"], { cwd: repo });
		const stagedOnly = buildWorkspaceManifest(repo, FINGERPRINT_A);
		// Staging moves the index object id.
		expect(stagedOnly.files.find(f => f.path === "base.txt")?.oid).not.toBe(committed.files.find(f => f.path === "base.txt")?.oid);
		expect(stagedOnly.staged).toContain("base.txt");
		// Unstaged edit after the add leaves the index oid, adds a dirty row.
		writeFileSync(join(repo, "base.txt"), "v2-staged-plus-unstaged\n");
		const afterUnstaged = buildWorkspaceManifest(repo, FINGERPRINT_A);
		expect(afterUnstaged.files.find(f => f.path === "base.txt")?.oid).toBe(stagedOnly.files.find(f => f.path === "base.txt")?.oid);
		expect(afterUnstaged.dirty.some(line => line.includes("base.txt"))).toBe(true);
		expect(stagedOnly.hash).not.toBe(afterUnstaged.hash);
	});

	it("binds the contract fingerprint — a different contract changes the hash", () => {
		expect(buildWorkspaceManifest(repo, FINGERPRINT_A).hash).not.toBe(buildWorkspaceManifest(repo, FINGERPRINT_B).hash);
	});

	it("excludes .git/.pi/node_modules from the file set", () => {
		mkdirSync(join(repo, "node_modules"));
		writeFileSync(join(repo, "node_modules/x.js"), "x\n");
		mkdirSync(join(repo, ".pi"));
		writeFileSync(join(repo, ".pi", "session.jsonl"), "x\n");
		const manifest = buildWorkspaceManifest(repo, FINGERPRINT_A);
		expect(manifest.files.some(f => f.path.startsWith("node_modules/"))).toBe(false);
		expect(manifest.files.some(f => f.path.startsWith(".pi/"))).toBe(false);
	});

	it("honors exclusions the repository declares itself", () => {
		mkdirSync(join(repo, ".pi"), { recursive: true });
		writeFileSync(join(repo, ".pi", "manifest-ignore"), "# build output\ntarget\ncoverage/lcov.info\n");
		const before = buildWorkspaceManifest(repo, FINGERPRINT_A);
		mkdirSync(join(repo, "target", "classes"), { recursive: true });
		writeFileSync(join(repo, "target", "classes", "App.class"), "x\n");
		mkdirSync(join(repo, "coverage"), { recursive: true });
		writeFileSync(join(repo, "coverage", "lcov.info"), "TN:\n");
		const after = buildWorkspaceManifest(repo, FINGERPRINT_A);
		expect(after.files.some(f => f.path.startsWith("target/"))).toBe(false);
		expect(after.files.some(f => f.path === "coverage/lcov.info")).toBe(false);
		// Paths the declaration did not cover still count.
		writeFileSync(join(repo, "coverage", "index.html"), "<html>\n");
		expect(buildWorkspaceManifest(repo, FINGERPRINT_A).hash).not.toBe(after.hash);
		expect(after.hash).toBe(before.hash);
	});

	it("never guesses build directories by name — undeclared output is a workspace change", () => {
		const before = buildWorkspaceManifest(repo, FINGERPRINT_A);
		mkdirSync(join(repo, "target"));
		writeFileSync(join(repo, "target", "app.jar"), "x\n");
		const after = buildWorkspaceManifest(repo, FINGERPRINT_A);
		expect(after.hash).not.toBe(before.hash);
		expect(manifestDelta(before, after)).toContain("created target/app.jar");
	});

	it("treats a widened declaration as a workspace change", () => {
		const before = buildWorkspaceManifest(repo, FINGERPRINT_A);
		mkdirSync(join(repo, ".pi"), { recursive: true });
		writeFileSync(join(repo, ".pi", "manifest-ignore"), "coverage\n");
		const after = buildWorkspaceManifest(repo, FINGERPRINT_A);
		expect(after.hash).not.toBe(before.hash);
		// The rule change carries no path; the delta names it so the cause stays visible.
		expect(manifestDelta(before, after)).toContain("declared coverage");
	});

	it("records index object ids per entry", () => {
		writeFileSync(join(repo, "sized.txt"), "abcdef\n");
		execFileSync("git", ["add", "sized.txt"], { cwd: repo });
		const manifest = buildWorkspaceManifest(repo, FINGERPRINT_A);
		const entry = manifest.files.find(f => f.path === "sized.txt");
		expect(entry?.oid).toMatch(/^[0-9a-f]{40,64}$/);
	});
});

describe("receipt binding end-to-end", () => {
	it("untracked file invalidates an existing PASS receipt", async () => {
		const { bindAcceptanceContract } = await import("../lib/execution-contract.ts");
		const { createVerifierReceipt, canComplete } = await import("../lib/verifier-runtime.ts");
		const { buildWorkspaceManifest } = await import("../lib/workspace-manifest.ts");

		const bound = bindAcceptanceContract("# Plan: p\n\n## Objective\nShip the change.\n", "plan");
		if ("error" in bound) throw new Error("expected contract");

		// Verify → PASS, bound to the current manifest.
		const receipt = createVerifierReceipt({
			contract: bound,
			workspaceManifestHash: buildWorkspaceManifest(repo, bound.fingerprint).hash,
			verification: { status: "PASS", results: [] },
			attempt: 1,
			verifier: { runId: "verifier-1", status: "PASS", summary: "objective satisfied" },
		});
		expect(canComplete(receipt, bound, buildWorkspaceManifest(repo, bound.fingerprint).hash)).toBe(true);

		// Add an untracked file → manifest changes → old receipt is stale.
		writeFileSync(join(repo, "sneaky-untracked.ts"), "x\n");
		const afterManifest = buildWorkspaceManifest(repo, bound.fingerprint);
		expect(canComplete(receipt, bound, afterManifest.hash)).toBe(false);
	});
});