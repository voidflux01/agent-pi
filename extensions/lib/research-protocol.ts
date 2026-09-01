// ABOUTME: Shared routing and prompt protocol for optional external research.
// ABOUTME: Keeps runtime-discovered web capability checks and evidence requirements consistent across modes.

const EXTERNAL_RESEARCH_PATTERNS = [
	"latest", "current", "recent", "version", "release", "api", "sdk", "documentation",
	"official", "standard", "specification", "cve", "security advisory", "third-party",
	"pricing", "availability", "compare", "competitor", "web", "online", "联网", "最新",
	"版本", "文档", "官方", "标准", "竞品", "调研", "研究", "外部资料",
];

export interface ResearchRoutingDecision {
	required: boolean;
	reason: string;
}

/** Conservative heuristic: explicit research language or unstable external facts. */
export function researchRoutingDecision(task: string): ResearchRoutingDecision {
	const normalized = task.toLowerCase();
	const matched = EXTERNAL_RESEARCH_PATTERNS.filter((pattern) => normalized.includes(pattern));
	if (matched.length === 0) return { required: false, reason: "No external-fact signal detected" };
	return { required: true, reason: `Matched external-research signals: ${matched.join(", ")}` };
}

export interface AvailableToolMetadata {
	name: string;
	description?: string;
}

/** Discover research tools from metadata instead of provider-specific names. */
export function discoverResearchTools(tools: readonly AvailableToolMetadata[]): string[] {
	const result: string[] = [];
	for (const tool of tools) {
		const name = String(tool.name || "").trim();
		if (!name || name === "tool_search" || name === "call_tool") continue;
		const text = `${name} ${tool.description || ""}`.toLowerCase();
		const looksLikeResearch = /(web|internet|online|search|query|url|page|content|fetch|extract)/.test(text)
			|| /(source|citation|evidence)/.test(text) && /(check|claim|verify|citation|evidence)/.test(text);
		const looksLikeUiOrTest = /(screenshot|click|navigate|browser automation|web test|local server|chat|viewer|dashboard|socket)/.test(text);
		const hasSideEffect = /(write|create|delete|remove|update|mutat|post|put|patch|send|submit|upload|install|execute|login|authenticate)/.test(text);
		if (looksLikeResearch && !looksLikeUiOrTest && !hasSideEffect) result.push(name);
	}
	return [...new Set(result)];
}

export function researcherPrompt(task: string, context = ""): string {
	return `Research the following task using current, source-backed external information. Prefer official and primary sources.

Task:
${task}

${context}

Return source URLs, retrieval dates, verified facts, uncertainty, conflicts, and failed lookups. Do not modify files or run shell commands.

Recovery for blocked URL fetches: if a direct fetch is blocked by SSRF protection, fake-IP resolution, robots policy, or a network boundary, do not retry the same URL repeatedly. Try a canonical equivalent host or an official mirror when the source identity remains clear. Use a proxy argument only if the selected tool schema explicitly supports it and a configured proxy is available; never invent proxy values. If it still fails, use search-result evidence or another independent source and record the failed URL and reason.`;
}

export const RESEARCH_HANDOFF_PROMPT = "When using external research, preserve the researcher report as context. Distinguish repository facts, source-backed external facts, and assumptions. Do not treat a citation alone as proof of an implementation result.";
