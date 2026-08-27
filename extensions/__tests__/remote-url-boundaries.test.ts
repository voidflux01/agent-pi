import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { validateRemoteWebUrl } from "../web-test.ts";
import { validatePublicUrl } from "../lib/remote-url-safety.ts";

describe("remote URL SSRF boundaries", () => {
	it("rejects loopback, special-use, and IPv4-mapped IPv6 targets", () => {
		for (const url of [
			"http://localhost:8080", "http://127.0.0.1", "http://2130706433",
			"http://[::1]", "http://[::]", "http://[0:0:0:0:0:ffff:7f00:1]",
			"http://[fd00::1]", "http://[fe80::1]", "http://metadata.google.internal",
		]) expect(validatePublicUrl(url)).toContain("private");
	});

	it("keeps client and worker lexical policies aligned", () => {
		expect(validateRemoteWebUrl("https://example.com")).toBeNull();
		expect(validateRemoteWebUrl("https://[::1]")).toContain("private");
		const worker = readFileSync(new URL("../web-test-worker/src/index.ts", import.meta.url), "utf8");
		expect(worker).toContain("validateResolvedHost");
		expect(worker).toContain("cloudflare-dns.com/dns-query");
	});
});
