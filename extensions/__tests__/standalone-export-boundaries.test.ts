import { describe, expect, it } from "bun:test";
import { createSpecStandaloneExport, saveStandaloneExport } from "../lib/viewer-standalone-export.ts";

describe("standalone export boundaries", () => {
	it("emits syntactically valid sanitizer scripts", () => {
		const html = createSpecStandaloneExport({ title: "x", documents: [] });
		const scripts = [...html.matchAll(new RegExp("<script>([\\s\\S]*?)</script>", "g"))].map((match) => match[1]);
		expect(scripts.length).toBeGreaterThan(0);
		for (const script of scripts) expect(() => new Function(script)).not.toThrow();
	});

	it("rejects path-traversing prefixes and constrains visual MIME types", () => {
		expect(() => saveStandaloneExport({ filePrefix: "../../escape", html: "x" })).toThrow("Invalid standalone export input");
		const html = createSpecStandaloneExport({ title: "x", documents: [{ label: "v", filePath: "x", isVisuals: true, visuals: [{ filePath: "x", mimeType: 'text/html"><script>', content: "not-base64" }] }] });
		expect(html).toContain("application/octet-stream");
		expect(html).toContain("const encoded = /^[A-Za-z0-9+/=]*$/");
	});
});
