import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ARTIFACT_LIMIT, digest, readBounded, redactEvidence, saveArtifact, safeWorkspacePath } from "../lib/workflow-artifacts.ts";

describe("workflow artifacts", () => {
	test("digest is stable sha256", () => {
		expect(digest("abc")).toHaveLength(64);
		expect(digest("abc")).toBe(digest("abc"));
		expect(digest("abc")).not.toBe(digest("abd"));
	});

	test("saveArtifact redacts, bounds and dedups immutable writes", () => {
		const cwd = mkdtempSync(join(tmpdir(), "agent-pi-artifactlib-"));
		const path = saveArtifact(cwd, "evals", { token: "secret-value", note: "user@example.com" }, "run-1");
		expect(path).toContain(".pi/workflow/evals/run-1.json");
		const content = readFileSync(path, "utf8");
		expect(content).toContain("[REDACTED]");
		expect(content).toContain("[REDACTED EMAIL]");
		expect(content).not.toContain("secret-value");
		expect(() => saveArtifact(cwd, "evals", { same: true }, "run-1")).toThrow(); // EEXIST dedup: immutable writes
		expect(() => saveArtifact(cwd, "../escape", {}, "x")).toThrow();
		expect(() => saveArtifact(cwd, "evals", {}, "bad_key!")).toThrow();
		expect(() => saveArtifact(cwd, "evals", { blob: "x".repeat(ARTIFACT_LIMIT + 1) }, "big")).toThrow();
	});

	test("readBounded enforces size limits, tail mode and regular files", () => {
		const cwd = mkdtempSync(join(tmpdir(), "agent-pi-artifactlib-"));
		writeFileSync(join(cwd, "small.txt"), "hello");
		expect(readBounded(cwd, "small.txt")).toBe("hello");
		writeFileSync(join(cwd, "big.txt"), "x".repeat(300));
		expect(() => readBounded(cwd, "big.txt", 128)).toThrow("size limit");
		expect(readBounded(cwd, "big.txt", 128, true).startsWith("x")).toBe(true);
		mkdirSync(join(cwd, "dir"));
		expect(() => readBounded(cwd, "dir")).toThrow();
		expect(() => readBounded(cwd, "missing.txt")).toThrow();
	});

	test("safeWorkspacePath rejects traversal and target-is-root", () => {
		const cwd = mkdtempSync(join(tmpdir(), "agent-pi-artifactlib-"));
		expect(safeWorkspacePath(cwd, "a/b.txt")).toBe(safeWorkspacePath(cwd, "a/b.txt"));
		expect(safeWorkspacePath(cwd, "a/b.txt").endsWith(join("a", "b.txt"))).toBe(true);
		expect(() => safeWorkspacePath(cwd, "../outside.txt")).toThrow();
		expect(() => safeWorkspacePath(cwd, ".")).toThrow("Path must be a workspace file");
	});
});

describe("redactEvidence", () => {
	test("masks credentials, keys, emails, IPs and control characters", () => {
		const text = redactEvidence([
			"api_key: \"sk-123\"",
			"-----BEGIN RSA PRIVATE KEY-----\\nabc\\n-----END RSA PRIVATE KEY-----",
			"mail bob@corp.example",
			"host 192.168.1.9",
			"ctl\x00char",
		].join(" "));
		expect(text).toContain("[REDACTED]");
		expect(text).toContain("[REDACTED PRIVATE KEY]");
		expect(text).toContain("[REDACTED EMAIL]");
		expect(text).toContain("[REDACTED IP]");
		expect(text).not.toContain("\x00");
	});
});
