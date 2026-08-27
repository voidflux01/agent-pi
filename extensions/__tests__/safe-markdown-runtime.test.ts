import { describe, expect, it } from "bun:test";
import { SAFE_MARKDOWN_RUNTIME } from "../lib/safe-markdown-runtime.ts";
import { createPlanStandaloneExport } from "../lib/viewer-standalone-export.ts";

describe("safe markdown runtime", () => {
	it("escapes HTML and rejects unsafe link protocols", () => {
		const windowObject: any = {};
		new Function("window", SAFE_MARKDOWN_RUNTIME)(windowObject);
		const html = windowObject.marked.parse(
			"<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1))\n\n[good](https://example.com)",
		);
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(html).not.toContain('href="javascript:');
		expect(html).toContain('href="https://example.com"');
	});

	it("keeps standalone exports free of remote parser scripts", () => {
		const html = createPlanStandaloneExport({ title: "Plan", markdown: "# Safe", mode: "plan" });
		expect(html).toContain("window.marked");
		expect(html).not.toContain("cdn.jsdelivr.net/npm/marked");
	});
});
