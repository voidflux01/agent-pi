// ABOUTME: Resolves the commander-mcp server.js path from the environment.
// ABOUTME: Returns "" when COMMANDER_MCP_SERVER_PATH is unset so callers can degrade gracefully.

export const COMMANDER_SERVER_PATH_ENV = "COMMANDER_MCP_SERVER_PATH";

/**
 * Path to the commander-mcp server entry point (server.js).
 * Configured via the COMMANDER_MCP_SERVER_PATH environment variable.
 * Returns "" when unconfigured — callers must skip spawning and report
 * Commander as unavailable instead of failing on a nonexistent path.
 */
export function resolveCommanderServerPath(): string {
	return process.env[COMMANDER_SERVER_PATH_ENV] || "";
}
