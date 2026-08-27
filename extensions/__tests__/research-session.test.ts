import { describe, expect, it } from "bun:test";
import { createResearchSession, loadResearchSession } from "../lib/research-session.ts";

describe("research session file boundaries", () => {
	it("rejects traversal IDs without reading outside the sessions directory", () => {
		expect(loadResearchSession("../package.json")).toBeNull();
		expect(loadResearchSession("/etc/passwd")).toBeNull();
	});

	it("generates filesystem-safe session IDs", () => {
		const session = createResearchSession("Improve API latency: <safe>");
		expect(session.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/);
	});
});
