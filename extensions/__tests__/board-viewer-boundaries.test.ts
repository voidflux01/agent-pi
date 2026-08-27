import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { generateBoardViewerHTML } from "../lib/board-viewer-html.ts";

describe("board viewer boundaries", () => {
	it("escapes the title and dynamic message type", () => {
		const html = generateBoardViewerHTML({ title: "<img src=x onerror=alert(1)>", port: 1 });
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(html).toContain("const rawType = String(msg.message_type || 'status')");
		expect(html).toContain("function numericText(value");
	});

	it("uses the shared capability auth on the server", () => {
		const source = readFileSync(new URL("../board-viewer.ts", import.meta.url), "utf8");
		expect(source).toContain("authorizeLocalServerRequest");
		expect(source).not.toContain('Access-Control-Allow-Origin\": \"*');
	});
});
