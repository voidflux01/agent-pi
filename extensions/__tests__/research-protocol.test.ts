import { describe, expect, it } from "vitest";
import { discoverResearchTools, researchRoutingDecision, researcherPrompt } from "../lib/research-protocol.ts";

describe("research routing", () => {
	it("detects unstable external-fact requests", () => {
		expect(researchRoutingDecision("Check the latest API version").required).toBe(true);
	});

	it("does not route a local-only lookup", () => {
		expect(researchRoutingDecision("Find the local parser implementation").required).toBe(false);
	});

	it("discovers research tools from descriptions rather than fixed names", () => {
		expect(discoverResearchTools([
			{ name: "search_web_now", description: "Search the internet and return sources" },
			{ name: "extract_page", description: "Fetch and extract content from a URL" },
			{ name: "check_claim", description: "Check a claim against web sources and return evidence" },
			{ name: "web_test", description: "Run a web test and capture a screenshot" },
			{ name: "publish_page", description: "Post content to a web page" },
		])).toEqual(["search_web_now", "extract_page", "check_claim"]);
	});

	it("keeps the research prompt read-only and source focused", () => {
		const prompt = researcherPrompt("Compare the current SDK versions");
		expect(prompt).toContain("source-backed");
		expect(prompt).toContain("Do not modify files");
		expect(prompt).toContain("do not retry the same URL repeatedly");
		expect(prompt).toContain("canonical equivalent host or an official mirror");
		expect(prompt).toContain("never invent proxy values");
	});
});
