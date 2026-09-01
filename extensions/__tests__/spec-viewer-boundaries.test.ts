import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { isWithinDirectory } from "../lib/path-safety.ts";
import { generateSpecViewerHTML } from "../lib/spec-viewer-html.ts";
import { discoverSpecDocuments } from "../spec-viewer.ts";

describe("spec viewer boundaries", () => {
	it("does not confuse sibling paths with descendants", () => {
		expect(isWithinDirectory("/tmp/project", "/tmp/project/file.md")).toBe(true);
		expect(isWithinDirectory("/tmp/project", "/tmp/project-evil/file.md")).toBe(false);
		expect(isWithinDirectory("/tmp/project", "/tmp/project/../secret")).toBe(false);
	});

	it("does not read markdown through an external symlink", () => {
		const root = mkdtempSync("/tmp/pi-spec-");
		const outside = mkdtempSync("/tmp/pi-spec-outside-");
		try {
			writeFileSync(`${outside}/secret.md`, "private");
			symlinkSync(`${outside}/secret.md`, `${root}/spec.md`);
			mkdirSync(`${root}/planning`);
			writeFileSync(`${root}/planning/requirements.md`, "safe");
			expect(discoverSpecDocuments(root).map((doc) => doc.filePath)).toEqual(["planning/requirements.md"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("escapes document labels and keeps script data inert", () => {
		const html = generateSpecViewerHTML({ title: "<img>", port: 1, documents: [{ key: "spec", label: "<script>alert(1)</script>", markdown: "</script><img src=x>", filePath: "spec.md" }] });
		expect(html).toContain("&lt;img&gt;");
		expect(html).toContain("function sanitizeMarkdownHtml(html)");
		expect(html).toContain("escapeHtml(doc.label)");
		expect(html).toContain("escapeHtml(JSON.stringify(String(c.id)))");
		expect(html).toContain("escapeHtml(JSON.stringify(url))");
		expect(html).toContain("<\\/script>");
		const source = readFileSync(new URL("../spec-viewer.ts", import.meta.url), "utf8");
		expect(source).toContain("allowedDocument");
		expect(source).toContain('typeof content !== "string"');
		expect(source).toContain("MAX_SPEC_REQUEST_BODY_BYTES = 256 * 1024");
		expect(source).toContain("readRequestBody(req, res");
		expect(source).not.toContain('req.on("data", (chunk) => { body += chunk; });');
	});
});
