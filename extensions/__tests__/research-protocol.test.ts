import { describe, expect, it } from "vitest";
import { discoverResearchTools, researchRoutingDecision, researcherPrompt } from "../lib/research-protocol.ts";
import { RESEARCH_ROUTING_PROMPT } from "../lib/mode-prompts.ts";

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

	it("defines a cross-mode scout-to-researcher handoff", () => {
		expect(RESEARCH_ROUTING_PROMPT).toContain("applies in every mode");
		expect(RESEARCH_ROUTING_PROMPT).toContain("external_research_needed: true");
		expect(RESEARCH_ROUTING_PROMPT).toContain("queries:");
		expect(RESEARCH_ROUTING_PROMPT).toContain("reason:");
		expect(RESEARCH_ROUTING_PROMPT).toContain("SCOUT investigates local repository");
		expect(RESEARCH_ROUTING_PROMPT).toContain("researcher investigates external facts");
	});

	it("describes mode-specific research reuse", () => {
		expect(RESEARCH_ROUTING_PROMPT).toContain("NORMAL: start with local work");
		expect(RESEARCH_ROUTING_PROMPT).toContain("PLAN/SPEC");
		expect(RESEARCH_ROUTING_PROMPT).toContain("TEAM: dispatch one shared researcher result");
		expect(RESEARCH_ROUTING_PROMPT).toContain("PIPELINE: dispatch researcher in the earliest");
		expect(RESEARCH_ROUTING_PROMPT).toContain("CHAIN: use researcher only when");
		expect(RESEARCH_ROUTING_PROMPT).toContain("subagent_create_batch");
		expect(RESEARCH_ROUTING_PROMPT).toContain("independently required");
	});
});
