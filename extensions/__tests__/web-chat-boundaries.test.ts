import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { generateWebChatHTML } from "../lib/web-chat-html.ts";

describe("web chat boundaries", () => {
	it("keeps bearer tokens out of page JavaScript and WebSocket URLs", () => {
		const html = generateWebChatHTML({ port: 1 });
		expect(html).toContain("let authenticated = false");
		expect(html).toContain("j < 6 && j < text.length");
		expect(html).toContain("submitPIN(text.slice(0, 6))");
		expect(html).toContain("new WebSocket(proto + '//' + location.host + '/ws')");
		expect(html).not.toContain("authToken");
	});

	it("allows only safe link schemes and uses constant-time cookie checks", () => {
		const html = generateWebChatHTML({ port: 1 });
		const source = readFileSync(new URL("../web-chat.ts", import.meta.url), "utf8");
		expect(html).toContain("https?:\\/\\/");
		expect(html).toContain("noopener noreferrer");
		expect(html).toContain("const attrHref = escapeHtml(safeHref)");
		expect(source).toContain("timingSafeEqual");
		expect(source).toContain('url.pathname === "/reset"');
		expect(source).toContain('broadcastWS(wsClients, "reset", {})');
		expect(source).toContain("resetShutdownTimer();");
		expect(source).toContain('broadcastWS(this.clients, "done", {});');
		expect(source).not.toContain("This fires for every message (including tool-use)");
		expect(source).toContain('execFileSync("which", ["cloudflared"]');
		expect(source).toContain("env: childEnvironment()");
		expect(source).not.toContain("execSync(");
	});
});
