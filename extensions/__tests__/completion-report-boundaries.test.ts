import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { execGit } from "../completion-report.ts";

describe("completion report boundaries", () => {
	it("passes git input as argument arrays", () => {
		const source = readFileSync(new URL("../completion-report.ts", import.meta.url), "utf8");
		expect(source).toContain("execFileSync(\"git\", args");
		expect(source).not.toContain("execSync(");
		expect(execGit(["rev-parse", "--is-inside-work-tree"], process.cwd())).toBe("true");
	});

	it("restricts rollback to files in the displayed report", () => {
		const source = readFileSync(new URL("../completion-report.ts", import.meta.url), "utf8");
		expect(source).toContain("File is not part of this report");
		expect(source).toContain("--end-of-options");
	});

	it("returns a structured completion blocker for non-Git workspaces", () => {
		const source = readFileSync(new URL("../completion-report.ts", import.meta.url), "utf8");
		expect(source).toContain("completionBlocked: true");
		expect(source).toContain("not a Git repository");
		expect(source).toContain("Do not output done:true");
	});
});
