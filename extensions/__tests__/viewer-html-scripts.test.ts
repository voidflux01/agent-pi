// ABOUTME: Viewer HTML inlines must be valid JS — a broken regex leaves the page empty.
import { describe, expect, it } from "vitest";
import { generatePlanViewerHTML } from "../lib/plan-viewer-html.ts";
import { generateSpecViewerHTML } from "../lib/spec-viewer-html.ts";
import { generateCompletionReportHTML } from "../lib/completion-report-html.ts";

function inlineScripts(html: string): string[] {
	return [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
}

function expectScriptsParse(html: string, label: string): void {
	const scripts = inlineScripts(html);
	expect(scripts.length, `${label} should inline at least one script`).toBeGreaterThan(0);
	for (const [i, src] of scripts.entries()) {
		expect(() => new Function(src), `${label} script[${i}]`).not.toThrow();
	}
}

describe("viewer inline scripts parse", () => {
	it("plan viewer", () => {
		const html = generatePlanViewerHTML({
			markdown: "# 修：show_plan\n\nBody with `code` and a [link](https://example.com).",
			title: "Fix: TUI Enter",
			mode: "plan",
			port: 63139,
		});
		expectScriptsParse(html, "plan");
		expect(html).toContain("new RegExp('^(https?:|mailto:|tel:|#|/)', 'i')");
	});

	it("spec viewer", () => {
		expectScriptsParse(
			generateSpecViewerHTML({ title: "Spec", documents: [], port: 1 }),
			"spec",
		);
	});

	it("completion report", () => {
		expectScriptsParse(
			generateCompletionReportHTML({
				report: {
					title: "Report",
					summary: "# Summary",
					files: [],
					baseRef: "HEAD",
					totalAdditions: 0,
					totalDeletions: 0,
				},
				port: 1,
			}),
			"completion",
		);
	});
});
