import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("file viewer boundaries", () => {
	it("uses argument arrays for browser and editor launch", () => {
		const source = readFileSync(new URL("../file-viewer.ts", import.meta.url), "utf8");
		expect(source).toContain('execFileSync("open", [url]');
		expect(source).toContain('spawn("open", ["-a", appName, filePath]');
		expect(source).not.toContain("execSync(");
	});

	it("protects the local server and rejects unsupported editors", () => {
		const source = readFileSync(new URL("../file-viewer.ts", import.meta.url), "utf8");
		expect(source).toContain("authorizeLocalServerRequest");
		expect(source).toContain("Unsupported editor");
		expect(source).toContain("MAX_FILE_VIEWER_REQUEST_BODY_BYTES = 256 * 1024");
		expect(source).toContain("readRequestBody(req, res");
		expect(source).toContain('pi.on("session_shutdown"');
		expect(source).toContain("cleanupServer();");
		expect(source).not.toContain('req.on("data", (chunk) => { body += chunk; });');
	});
});
