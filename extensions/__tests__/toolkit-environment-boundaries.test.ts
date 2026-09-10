import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("toolkit worker environment boundaries", () => {
	it("uses the least-privilege child environment", () => {
		const source = readFileSync(new URL("../toolkit-commands.ts", import.meta.url), "utf8");
		expect(source).toContain('childEnvironment({ PI_SUBAGENT: "1" })');
		expect(source).not.toContain("env: { ...process.env");
	});

	it("caps worker stdout while it is being captured", () => {
		const source = readFileSync(new URL("../toolkit-commands.ts", import.meta.url), "utf8");
		expect(source).toContain("MAX_WORKER_CAPTURE");
		expect(source).toContain("outputTruncated");
		expect(source).not.toContain("output += chunk;");
	});

	it("caps worker stderr through the shared bounded appender", () => {
		// The shared appender lives with the toolkit CLI runner; orchestrators no longer
		// capture subprocess stderr themselves.
		const appender = readFileSync(new URL("../lib/toolkit-cli.ts", import.meta.url), "utf8");
		expect(appender).toContain("export function appendBoundedOutput");
		expect(appender).toContain("output = appendBoundedOutput(output, chunk)");
		const team = readFileSync(new URL("../agent-team.ts", import.meta.url), "utf8");
		expect(team).not.toContain("stderrBuf += chunk");
	});
});
