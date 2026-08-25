// ABOUTME: Tests that loadAgentModelsConfig honors the user-level ~/.pi config.
// ABOUTME: Verifies priority: project config > user home config > package repo fallback.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadAgentModelsConfig, loadExplicitAgentModelsConfig } from "../lib/agent-defs.ts";

function writeModelsJson(dir: string, defaultModel: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "models.json"),
		JSON.stringify({
			default: { provider: "anthropic", model: defaultModel },
			agents: {},
		}),
	);
}

describe("loadAgentModelsConfig user-level config", () => {
	let fakeHome: string;
	let savedHome: string | undefined;
	let savedUserProfile: string | undefined;

	beforeEach(() => {
		fakeHome = mkdtempSync(join(tmpdir(), "pi-home-"));
		savedHome = process.env.HOME;
		savedUserProfile = process.env.USERPROFILE;
		process.env.HOME = fakeHome;
		process.env.USERPROFILE = fakeHome;
	});

	afterEach(() => {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		if (savedUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = savedUserProfile;
		rmSync(fakeHome, { recursive: true, force: true });
	});

	it("reads ~/.pi/agents/models.json when no project config exists", () => {
		writeModelsJson(join(fakeHome, ".pi", "agents"), "user-level-model");
		const config = loadAgentModelsConfig("/nonexistent/cwd");
		expect(config.default.model).toBe("user-level-model");
	});

	it("reads ~/.pi/agent/agents/models.json (Pi config dir layout)", () => {
		writeModelsJson(join(fakeHome, ".pi", "agent", "agents"), "pi-config-dir-model");
		const config = loadAgentModelsConfig("/nonexistent/cwd");
		expect(config.default.model).toBe("pi-config-dir-model");
	});

	it("prefers user-level config over the package repo fallback", () => {
		writeModelsJson(join(fakeHome, ".pi", "agents"), "user-level-model");
		const extProjectDir = mkdtempSync(join(tmpdir(), "pi-pkg-"));
		try {
			writeModelsJson(join(extProjectDir, "agents"), "repo-fallback-model");
			const config = loadAgentModelsConfig("/nonexistent/cwd", extProjectDir);
			expect(config.default.model).toBe("user-level-model");
		} finally {
			rmSync(extProjectDir, { recursive: true, force: true });
		}
	});

	it("prefers project-local config over user-level config", () => {
		writeModelsJson(join(fakeHome, ".pi", "agents"), "user-level-model");
		const cwd = mkdtempSync(join(tmpdir(), "pi-cwd-"));
		try {
			writeModelsJson(join(cwd, ".pi", "agents"), "project-model");
			const config = loadAgentModelsConfig(cwd);
			expect(config.default.model).toBe("project-model");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("loads project/user routing without consulting package defaults", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-cwd-"));
		try {
			writeModelsJson(join(cwd, ".pi", "agents"), "explicit-project-model");
			const config = loadExplicitAgentModelsConfig(cwd);
			expect(config.default.model).toBe("explicit-project-model");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("returns an inheritance marker when no explicit routing exists", () => {
		const config = loadExplicitAgentModelsConfig("/nonexistent/cwd");
		expect(config.default).toEqual({ provider: "", model: "" });
		expect(config.agents).toEqual({});
	});

	it("skips user-level files that do not match the agents-config schema", () => {
		// ~/.pi/agent/models.json is Pi's provider-definitions file (different schema)
		mkdirSync(join(fakeHome, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(fakeHome, ".pi", "agents", "models.json"),
			JSON.stringify({ providers: { synthetic: { baseUrl: "http://localhost" } } }),
		);
		const config = loadAgentModelsConfig("/nonexistent/cwd");
		expect(config.default.provider).toBe("anthropic");
		expect(config.default.model).toBe("claude-haiku-4-5-20251001");
	});
});
