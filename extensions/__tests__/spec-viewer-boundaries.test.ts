import { describe, expect, it } from "bun:test";
import { isWithinDirectory } from "../lib/path-safety.ts";
import { generateSpecViewerHTML } from "../lib/spec-viewer-html.ts";

describe("spec viewer boundaries", () => {
	it("does not confuse sibling paths with descendants", () => {
		expect(isWithinDirectory("/tmp/project", "/tmp/project/file.md")).toBe(true);
		expect(isWithinDirectory("/tmp/project", "/tmp/project-evil/file.md")).toBe(false);
		expect(isWithinDirectory("/tmp/project", "/tmp/project/../secret")).toBe(false);
	});

	it("escapes document labels and keeps script data inert", () => {
		const html = generateSpecViewerHTML({ title: "<img>", port: 1, documents: [{ key: "spec", label: "<script>alert(1)</script>", markdown: "</script><img src=x>", filePath: "spec.md" }] });
		expect(html).toContain("&lt;img&gt;");
		expect(html).toContain("function sanitizeMarkdownHtml(html)");
		expect(html).toContain("<\\/script>");
	});
});
