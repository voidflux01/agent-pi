import { describe, expect, it } from "vitest";
import { classifyTool } from "../lib/tool-classification.ts";

// Inventory captured from a real provider-free `pi --mode json` startup with
// this repository's normal extension discovery enabled.
const REAL_PI_TOOLS = [
	"advance_phase", "advisor", "agent_browser", "ask_parent", "ask_user", "ask_user_question", "bash", "call_tool", "close_viewer", "compose_exec", "cycle_memory",
	"debug_capture", "edit", "fetch_content", "find", "get_search_content", "grep", "ls", "mcp", "mcpScript", "memory_correct", "memory_feedback", "memory_search", "memory_store_result", "network_inspect", "pipeline_status", "powershell", "preview_export", "read", "recall", "safe_port_scan", "save_research", "security_news", "set_mode", "show_board", "show_cleanup", "show_file", "show_plan", "show_report", "show_reports", "show_research", "show_security_report", "show_sounds", "show_spec", "source_check", "subagent_batch_recover", "subagent_cleanup", "subagent_continue", "subagent_create", "subagent_create_batch", "subagent_list", "subagent_remove", "subagent_resume", "subagent_wait", "tasks", "team_batch_recover", "tool_search", "verify_execution", "web_search", "write",
];

describe("tool classification inventory", () => {
	it("classifies every tool registered by the current Pi startup probe", () => {
		const unknown = REAL_PI_TOOLS.filter((name) => classifyTool(name).intent === "unknown");
		expect(unknown).toEqual([]);
	});

	it("keeps risky network and state-changing tools out of read-only", () => {
		expect(classifyTool("mcpScript").readOnly).toBe(false);
		expect(classifyTool("mcp__dbx__list_tables")).toMatchObject({ intent: "network", readOnly: false });
		expect(classifyTool("external_custom_tool", "Inspect local records")).toMatchObject({ intent: "read", readOnly: true });
		expect(classifyTool("external_custom_tool", "Perform an operation")).toMatchObject({ intent: "unknown", readOnly: false });
	});
});
