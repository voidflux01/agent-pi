import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { validateRemoteWebUrl } from "../web-test.ts";

describe("web test network and resource boundaries", () => {
	it("rejects loopback aliases and private IPv6 forms", () => {
		for (const url of ["http://localhost:8080", "http://127.0.0.1", "http://[::1]", "http://[::ffff:7f00:1]", "http://192.168.1.1"]) {
			expect(validateRemoteWebUrl(url)).toContain("private");
		}
		expect(validateRemoteWebUrl("https://example.com")).toBeNull();
	});

	it("keeps worker-side SSRF and body/screenshot limits enabled", () => {
		const source = readFileSync(new URL("../web-test-worker/src/index.ts", import.meta.url), "utf8");
		expect(source).toContain("MAX_SCREENSHOT_BYTES");
		expect(source).toContain("Request body too large");
		expect(source).toContain("validatePublicUrl");
		expect(source).toContain("validateResolvedHost");
		const clientSource = readFileSync(new URL("../web-test.ts", import.meta.url), "utf8");
		expect(clientSource).toContain("env: childEnvironment()");
	});
});
