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
	});
});
