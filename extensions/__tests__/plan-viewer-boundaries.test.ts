import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("plan viewer boundaries", () => {
	it("uses capability auth and argument-safe browser launch", () => {
		const source = readFileSync(new URL("../plan-viewer.ts", import.meta.url), "utf8");
		expect(source).toContain("authorizeLocalServerRequest");
		expect(source).toContain('execFileSync("open", [url]');
		expect(source).not.toContain("Access-Control-Allow-Origin");
		expect(source).not.toContain("execSync(");
	});
});
