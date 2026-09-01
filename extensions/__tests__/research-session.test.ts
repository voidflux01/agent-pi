import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createResearchSession, loadResearchSession, saveResearchSession } from "../lib/research-session.ts";

describe("research session file boundaries", () => {
	it("rejects traversal IDs without reading outside the sessions directory", () => {
		expect(loadResearchSession("../package.json")).toBeNull();
		expect(loadResearchSession("/etc/passwd")).toBeNull();
	});

	it("generates filesystem-safe session IDs", () => {
		const session = createResearchSession("Improve API latency: <safe>");
		expect(session.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/);
	});

	it("supports source-backed web research without changing the legacy shape", () => {
		const session = createResearchSession("Research a current API");
		session.webResearch = {
			query: "current API",
			sources: [{ url: "https://example.com/docs", title: "Docs", retrievedAt: new Date().toISOString() }],
			verifiedFacts: "The API is versioned.",
			uncertainty: "",
			failures: "",
		};
		saveResearchSession(session);
		const loaded = loadResearchSession(session.id);
		expect(loaded?.webResearch?.sources[0].url).toBe("https://example.com/docs");
		rmSync(join(process.cwd(), ".context", "research-sessions", `${session.id}.json`), { force: true });
	});
});
