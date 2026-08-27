import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("debug capture boundaries", () => {
	it("checks fixed prerequisites without a shell", () => {
		const source = readFileSync(new URL("../debug-capture.ts", import.meta.url), "utf8");
		expect(source).toContain('execFileSync("which", ["vhs"]');
		expect(source).toContain('execFileSync("which", ["ttyd"]');
		expect(source).not.toContain("execSync(");
	});

	it("quotes untrusted prompt text before placing it in a VHS command", () => {
		const source = readFileSync(new URL("../debug-capture.ts", import.meta.url), "utf8");
		expect(source).toContain("shellQuote(prompt.slice(0, 4000))");
		expect(source).toContain("safeVhsText(terminalCommand, 5000)");
		expect(source).toContain("env: childEnvironment()");
	});
});
