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

	it("keeps plan comments separate from markdown and returns change requests", () => {
		const source = readFileSync(new URL("../plan-viewer.ts", import.meta.url), "utf8");
		const html = readFileSync(new URL("../lib/plan-viewer-html.ts", import.meta.url), "utf8");
		expect(source).toContain("planCommentsPath");
		expect(source).toContain("/save-comments");
		expect(source).toContain('action: \"changes_requested\"');
		expect(html).toContain("let comments = ${escapedComments};");
		expect(html).toContain("window.requestChanges");
		expect(html).toContain("plan-comment-btn");
	});
});
