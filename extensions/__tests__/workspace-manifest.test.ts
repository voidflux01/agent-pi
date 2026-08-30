import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkspaceManifest } from "../lib/workspace-manifest.ts";

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
afterEach(() => { try { rmSync(repo, { recursive: true, force: true }); } catch {} });

const FINGERPRINT_A = "a".repeat(64);
const FINGERPRINT_B = "b".repeat(64);

describe("workspace manifest", () => {
	it("hashes tracked content — a working-tree edit changes the manifest hash", () => {
		const before = buildWorkspaceManifest(repo, FINGERPRINT_A);
		writeFileSync(join(repo, "base.txt"), "base changed\n");
		const after = buildWorkspaceManifest(repo, FINGERPRINT_A);
		expect(after.hash).not.toBe(before.hash);
		expect(after.files.find(f => f.path === "base.txt")?.hash).not.toBe(before.files.find(f => f.path === "base.txt")?.hash);
	});

	it("includes untracked files — a new untracked file changes the hash", () => {
		const before = buildWorkspaceManifest(repo, FINGERPRINT_A);
		writeFileSync(join(repo, "new-untracked.ts"), "x\n");
		const after = buildWorkspaceManifest(repo, FINGERPRINT_A);
		expect(after.hash).not.toBe(before.hash);
		expect(after.untracked).toContain("new-untracked.ts");
		expect(after.files.some(f => f.path === "new-untracked.ts")).toBe(true);
	});

	it("covers staged AND unstaged content", () => {
		writeFileSync(join(repo, "base.txt"), "v1\n");
		execFileSync("git", ["add", "base.txt"], { cwd: repo });
		const stagedOnly = buildWorkspaceManifest(repo, FINGERPRINT_A);
		// Unstaged edit after the add is still visible in the manifest.
		writeFileSync(join(repo, "base.txt"), "v2-staged-plus-unstaged\n");
		const afterUnstaged = buildWorkspaceManifest(repo, FINGERPRINT_A);
		expect(stagedOnly.staged).toContain("base.txt");
		expect(stagedOnly.files.find(f => f.path === "base.txt")?.hash).not.toBe(afterUnstaged.files.find(f => f.path === "base.txt")?.hash);
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

	it("records file size and content hash per entry", () => {
		writeFileSync(join(repo, "sized.txt"), "abcdef\n");
		const manifest = buildWorkspaceManifest(repo, FINGERPRINT_A);
		const entry = manifest.files.find(f => f.path === "sized.txt");
		expect(entry?.size).toBe(7);
		expect(entry?.hash).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("receipt binding end-to-end (acceptance criteria 1-4)", () => {
	it("untracked file invalidates an existing PASS receipt", async () => {
		const { bindAcceptanceContract } = await import("../lib/execution-contract.ts");
		const { runIsolatedVerifier } = await import("../lib/isolated-verifier.ts");
		const { createVerifierReceipt, canComplete } = await import("../lib/verifier-runtime.ts");
		const { buildWorkspaceManifest } = await import("../lib/workspace-manifest.ts");
		const { runDeterministicVerification } = await import("../lib/deterministic-verifier.ts");

		const plan = `# Plan: p\n\n## Contract\n- [cmd] ${process.execPath} -e "process.exit(0)"\n`;
		const bound = bindAcceptanceContract(plan, "plan");
		if ("error" in bound) throw new Error("expected contract");

		// Verify → PASS, bound to current manifest.
		const first = await runIsolatedVerifier({ cwd: repo, contract: bound, attempt: 1 });
		const initialManifest = buildWorkspaceManifest(repo, bound.fingerprint);
		expect(first.receipt?.status).toBe("PASS");
		expect(canComplete(first.receipt, bound, initialManifest.hash)).toBe(true);

		// Add an untracked file → manifest changes → old receipt is stale.
		writeFileSync(join(repo, "sneaky-untracked.ts"), "x\n");
		const afterManifest = buildWorkspaceManifest(repo, bound.fingerprint);
		expect(canComplete(first.receipt, bound, afterManifest.hash)).toBe(false);
	});

	it("failing command produces a FAIL receipt that blocks completion", async () => {
		const { bindAcceptanceContract } = await import("../lib/execution-contract.ts");
		const { runIsolatedVerifier } = await import("../lib/isolated-verifier.ts");
		const { canComplete } = await import("../lib/verifier-runtime.ts");
		const { buildWorkspaceManifest } = await import("../lib/workspace-manifest.ts");

		const plan = `# Plan: p\n\n## Contract\n- [cmd] ${process.execPath} -e "process.exit(3)"\n`;
		const bound = bindAcceptanceContract(plan, "plan");
		if ("error" in bound) throw new Error("expected contract");
		const verification = await runIsolatedVerifier({ cwd: repo, contract: bound, attempt: 1 });
		const manifest = buildWorkspaceManifest(repo, bound.fingerprint);
		expect(verification.receipt?.status).toBe("FAIL");
		expect(canComplete(verification.receipt, bound, manifest.hash)).toBe(false);
	});
});