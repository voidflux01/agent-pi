import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { generateReportsViewerHTML } from "../lib/reports-viewer-html.ts";

describe("reports viewer boundaries", () => {
	it("escapes report fields used in HTML and inline handlers", () => {
		const html = generateReportsViewerHTML({
			title: "<script>alert(1)</script>", port: 1, entries: [{
				id: "x\");alert(1)//", category: "completion", title: "<b>bad</b>", summary: "summary", searchText: "bad",
				createdAt: "2025-01-01", updatedAt: "2025-01-01",
			} as any],
		});
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain("return escapeHtml(JSON.stringify(String(value))");
		expect(html).toContain("escapeHtml(entry.category)");
	});

	it("requires capability auth before serving report data", () => {
		const source = readFileSync(new URL("../reports-viewer.ts", import.meta.url), "utf8");
		expect(source).toContain("authorizeLocalServerRequest");
		expect(source).not.toContain("execSync(");
		expect(source).toContain('spawn("pi", [route, path]');
		expect(source).toContain("MAX_REPORTS_REQUEST_BODY_BYTES = 64 * 1024");
		expect(source).toContain("readRequestBody(req, res");
		expect(source).toContain("server.on(\"close\", () => clearInterval(heartbeatCheck))");
		expect(source).not.toContain('req.on("data", (chunk) => { body += chunk; });');
	});
});
