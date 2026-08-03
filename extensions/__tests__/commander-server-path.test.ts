// ABOUTME: Tests for the commander-mcp server path resolver.
// ABOUTME: Verifies env-var configuration and empty fallback when unconfigured.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveCommanderServerPath, COMMANDER_SERVER_PATH_ENV } from "../lib/commander-server-path.ts";

describe("resolveCommanderServerPath", () => {
	let savedEnv: string | undefined;

	beforeEach(() => {
		savedEnv = process.env[COMMANDER_SERVER_PATH_ENV];
	});

	afterEach(() => {
		if (savedEnv === undefined) {
			delete process.env[COMMANDER_SERVER_PATH_ENV];
		} else {
			process.env[COMMANDER_SERVER_PATH_ENV] = savedEnv;
		}
	});

	it("returns the path from COMMANDER_MCP_SERVER_PATH when set", () => {
		process.env[COMMANDER_SERVER_PATH_ENV] = "/opt/commander/server.js";
		expect(resolveCommanderServerPath()).toBe("/opt/commander/server.js");
	});

	it("returns empty string when the env var is unset", () => {
		delete process.env[COMMANDER_SERVER_PATH_ENV];
		expect(resolveCommanderServerPath()).toBe("");
	});

	it("returns empty string when the env var is empty", () => {
		process.env[COMMANDER_SERVER_PATH_ENV] = "";
		expect(resolveCommanderServerPath()).toBe("");
	});
});
