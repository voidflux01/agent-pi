import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { generateCleanupViewerHTML } from "../lib/cleanup-viewer-html.ts";

describe("cleanup viewer boundaries", () => {
	it("refuses symlink deletion and bounds recursive work", () => {
		const source = readFileSync(new URL("../cleanup-viewer.ts", import.meta.url), "utf8");
		expect(source).toContain("MAX_DEPTH = 20");
		expect(source).toContain("MAX_FILES = 10_000");
		expect(source).toContain("MAX_CLEANUP_REQUEST_BODY_BYTES = 256 * 1024");
		expect(source).toContain("readRequestBody(req, res");
		expect(source).not.toContain('req.on("data", (chunk) => { body += chunk; });');
		expect(source).toContain("MAX_DELETION_LOG_BYTES = 256 * 1024");
		expect(source).toContain("deletionLogWriteChain");
		expect(source).toContain("flatMap((line)");
		expect(source).toContain("Refusing to delete symbolic links");
		expect(source).toContain("sizedEntryCount");
	});

	it("uses loopback API URLs in the generated viewer", () => {
		const html = generateCleanupViewerHTML({ defaultDir: "/tmp", port: 1 });
		expect(html).toContain("http://127.0.0.1:' + PORT");
		expect(html).not.toContain("http://localhost:' + PORT");
	});
});
