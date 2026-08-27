import { describe, expect, it } from "bun:test";
import { SAFE_MARKDOWN_RUNTIME } from "../lib/safe-markdown-runtime.ts";
import { createPlanStandaloneExport } from "../lib/viewer-standalone-export.ts";
import { generatePlanViewerHTML } from "../lib/plan-viewer-html.ts";
import { generateCompletionReportHTML, type ReportData } from "../lib/completion-report-html.ts";
import { generateSpecViewerHTML } from "../lib/spec-viewer-html.ts";
import { generateFileViewerHTML } from "../lib/file-viewer-html.ts";

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

	it("keeps authenticated viewers free of remote executable dependencies", () => {
		const report: ReportData = { title: "Report", summary: "# Summary", files: [], baseRef: "HEAD", totalAdditions: 0, totalDeletions: 0 };
		const pages = [
			generatePlanViewerHTML({ title: "Plan", markdown: "# Plan", mode: "plan", port: 1 }),
			generateCompletionReportHTML({ report, port: 1 }),
			generateSpecViewerHTML({ title: "Spec", documents: [], port: 1 }),
			generateFileViewerHTML({ title: "File", filePath: "x.ts", content: "const x = 1", port: 1, editable: false }),
		];
		for (const page of pages) {
			expect(page).not.toMatch(/<script\s+src=/i);
			expect(page).not.toContain("cdn.jsdelivr.net");
		}
	});
});
