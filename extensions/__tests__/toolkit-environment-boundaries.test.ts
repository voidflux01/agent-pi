import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("toolkit worker environment boundaries", () => {
	it("uses the least-privilege child environment", () => {
		const source = readFileSync(new URL("../toolkit-commands.ts", import.meta.url), "utf8");
		expect(source).toContain('childEnvironment({ PI_SUBAGENT: "1" })');
		expect(source).not.toContain("env: { ...process.env");
	});
});
