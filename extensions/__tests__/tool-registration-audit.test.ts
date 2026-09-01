import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const EXTENSIONS_DIR = join(import.meta.dir, "..");

/** Extract a registerTool object without being confused by strings/comments. */
function registeredObjects(source: string): string[] {
	const objects: string[] = [];
	let searchFrom = 0;

	while (true) {
		const directMarker = source.indexOf("pi.registerTool({", searchFrom);
		const wrappedMarker = source.indexOf("registerToolWithExecutor(pi, {", searchFrom);
		const marker = directMarker < 0 ? wrappedMarker : wrappedMarker < 0 ? directMarker : Math.min(directMarker, wrappedMarker);
		if (marker < 0) break;
		const start = marker + (marker === directMarker ? "pi.registerTool(".length : "registerToolWithExecutor(pi, ".length);
		let depth = 0;
		let quote = "";
		let escaped = false;
		let lineComment = false;
		let blockComment = false;

		for (let i = start; i < source.length; i++) {
			const ch = source[i];
			const next = source[i + 1];
			if (lineComment) {
				if (ch === "\n") lineComment = false;
				continue;
			}
			if (blockComment) {
				if (ch === "*" && next === "/") { blockComment = false; i++; }
				continue;
			}
			if (quote) {
				if (escaped) { escaped = false; continue; }
				if (ch === "\\") { escaped = true; continue; }
				if (ch === quote) quote = "";
				continue;
			}
			if (ch === "/" && next === "/") { lineComment = true; i++; continue; }
			if (ch === "/" && next === "*") { blockComment = true; i++; continue; }
			if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
			if (ch === "{") depth++;
			if (ch === "}") {
				depth--;
				if (depth === 0) {
					objects.push(source.slice(start, i + 1));
					searchFrom = i + 1;
					break;
				}
			}
		}
	}

	return objects;
}

describe("registered tool lifecycle audit", () => {
	test("every registerTool object has an identity and executable terminal handler", () => {
		const files = readdirSync(EXTENSIONS_DIR)
			.filter((name) => name.endsWith(".ts"))
			.map((name) => join(EXTENSIONS_DIR, name));
		const registrations = files.flatMap((file) => registeredObjects(readFileSync(file, "utf8")).map((object) => ({ file, object })));

		expect(registrations).toHaveLength(39);
		for (const { file, object } of registrations) {
			const hasStaticName = /\bname\s*:\s*["']([^"']+)["']/.test(object);
			const hasDynamicName = /\bname\s*:\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?/.test(object);
			expect(hasStaticName || hasDynamicName, file).toBe(true);
			expect(object).toMatch(/\bexecute\s*(?::|\()/);
			expect(object).toMatch(/\breturn\b/);
		}
		for (const file of files) {
			if (file.endsWith("/tool-caller.ts")) continue;
			expect(readFileSync(file, "utf8")).not.toContain("pi.registerTool({");
		}
	});
});
