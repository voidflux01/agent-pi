import { describe, expect, it } from "bun:test";
import { generateResearchViewerHTML } from "../lib/research-viewer-html.ts";

describe("research viewer rendering", () => {
	it("escapes summary fields and keeps numeric rendering bounded", () => {
		const html = generateResearchViewerHTML({
			title: "<title>",
			port: 1234,
			sessions: [{ id: "session-1", status: "paused", goal: "<img src=x onerror=alert(1)>", metricName: "latency", metricDirection: "higher", final: 2, baseline: 1, iterationCount: 1, keepCount: 1, discardCount: 0, crashCount: 0, nextStepCount: 0, nextStepsDone: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01", tags: [] }],
		});
		expect(html).toContain("&lt;title&gt;");
		expect(html).toContain("function escapeHtmlJS(str)");
		expect(html).not.toContain("numberTextnumberText");
		expect(html).toContain("function numberValue(value)");
	});

	it("only permits http(s) protocols for external research links", () => {
		const html = generateResearchViewerHTML({ title: "Research", port: 1234, sessions: [] });

		expect(html).toContain("String(source.url || '').match(/^https?:\\/\\//i)");
	});
});
