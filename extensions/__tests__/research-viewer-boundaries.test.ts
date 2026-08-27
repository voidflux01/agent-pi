import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("research viewer boundaries", () => {
	it("uses capability auth and safe process arguments", () => {
		const source = readFileSync(new URL("../research-viewer.ts", import.meta.url), "utf8");
		expect(source).toContain("authorizeLocalServerRequest");
		expect(source).toContain('execFileSync("open", [url]');
		expect(source).not.toContain("Access-Control-Allow-Origin");
		expect(source).not.toContain("execSync(");
		const html = readFileSync(new URL("../lib/research-viewer-html.ts", import.meta.url), "utf8");
		expect(html).toContain("escapeHtmlJS(formatDate(s.implementation.startedAt))");
		expect(html).toContain("escapeHtmlJS(formatDate(s.implementation.completedAt))");
	});
});
