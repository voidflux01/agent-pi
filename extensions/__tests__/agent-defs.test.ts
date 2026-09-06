// ABOUTME: Tests for parseAgentMdFile — the unified team/chain/pipeline agent .md parser.
// ABOUTME: Covers chain default fallback, team includeFile, no-fallback unresolved model,
// missing name, and malformed files.

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentMdFile, type AgentModelsConfig } from "../lib/agent-defs.ts";

let dir: string;

const CONFIG: AgentModelsConfig = {
	default: { provider: "anthropic", model: "claude-default" },
	agents: {
		scoped: { provider: "openai", model: "gpt-scoped" },
		empty: { provider: "openai", model: "" },
	},
};

function writeAgent(name: string, extra = ""): string {
	mkdirSync(dir, { recursive: true });
	const p = join(dir, `${name}.md`);
	writeFileSync(p, `---\nname: ${name}\ndescription: Test agent\n${extra}---\nYou are ${name}.\n`);
	return p;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agent-defs-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("parseAgentMdFile", () => {
	it("chain: falls back to modelsConfig.default and resolves when default has a model", () => {
		const p = writeAgent("unlisted");
		const def = parseAgentMdFile(p, CONFIG, { defaultFallback: true });
		expect(def?.model).toBe("anthropic/claude-default");
	});

	it("chain: does not resolve when entry exists but has no model", () => {
		const p = writeAgent("empty");
		const def = parseAgentMdFile(p, CONFIG, { defaultFallback: true });
		expect(def?.model).toBe("");
	});

	it("chain: prefers the scoped agent entry over default", () => {
		const p = writeAgent("scoped");
		const def = parseAgentMdFile(p, CONFIG, { defaultFallback: true });
		expect(def?.model).toBe("openai/gpt-scoped");
	});

	it("team: includeFile adds file: filePath to the def", () => {
		const p = writeAgent("scoped");
		const def = parseAgentMdFile(p, CONFIG, { includeFile: true });
		expect(def?.file).toBe(p);
	});

	it("team/pipeline: no default fallback — agent not in config leaves model unresolved", () => {
		const p = writeAgent("unlisted");
		const def = parseAgentMdFile(p, CONFIG, {});
		expect(def?.model).toBe("");
	});

	it("frontmatter model is used when models.json has no entry", () => {
		const p = writeAgent("unlisted", "model: frontmatter/model\n");
		const def = parseAgentMdFile(p, CONFIG, {});
		expect(def?.model).toBe("frontmatter/model");
	});

	it("missing name returns null", () => {
		const p = join(dir, "noname.md");
		mkdirSync(dir, { recursive: true });
		writeFileSync(p, "---\ndescription: No name\n---\nBody.\n");
		expect(parseAgentMdFile(p, CONFIG, { includeFile: true })).toBeNull();
	});

	it("malformed file (no frontmatter) returns null", () => {
		const p = join(dir, "bad.md");
		mkdirSync(dir, { recursive: true });
		writeFileSync(p, "just some text, no frontmatter\n");
		expect(parseAgentMdFile(p, CONFIG, {})).toBeNull();
	});

	it("unreadable file returns null", () => {
		expect(parseAgentMdFile(join(dir, "does-not-exist.md"), CONFIG, {})).toBeNull();
	});
});
