import { describe, expect, it } from "vitest";
import { classifyTool } from "../lib/tool-classification.ts";

// Inventory captured from a real provider-free `pi --mode json` startup with
// this repository's normal extension discovery enabled.
const REAL_PI_TOOLS = [
	"advance_phase", "advisor", "agent_browser", "ask_parent", "ask_user", "ask_user_question", "bash", "call_tool", "close_viewer", "compose_exec", "cycle_memory",
	"dbx_dbx_add_connection", "dbx_dbx_close_session", "dbx_dbx_describe_table", "dbx_dbx_duplicate_connection", "dbx_dbx_execute_and_show", "dbx_dbx_execute_query", "dbx_dbx_execute_redis_command", "dbx_dbx_get_schema_context", "dbx_dbx_list_connections", "dbx_dbx_list_tables", "dbx_dbx_open_session", "dbx_dbx_open_table", "dbx_dbx_remove_connection",
	"debug_capture", "dispatch_agent", "dispatch_agents", "dispatch_team_batch", "edit", "fetch_content", "find", "get_search_content", "grep", "ls", "mcp", "mcpScript", "memory_correct", "memory_feedback", "memory_search", "memory_store_result", "network_inspect", "orchestration_recover", "orchestration_status", "pipeline_status", "powershell", "preview_export", "read", "recall", "resume_handoff", "run_chain", "safe_port_scan", "save_research", "security_news", "set_mode", "show_board", "show_cleanup", "show_file", "show_plan", "show_report", "show_reports", "show_research", "show_security_report", "show_sounds", "show_spec", "source_check", "subagent_batch_recover", "subagent_cleanup", "subagent_continue", "subagent_create", "subagent_create_batch", "subagent_list", "subagent_remove", "subagent_resume", "subagent_wait", "tasks", "team_batch_recover", "tool_search", "verify_execution", "web_search", "write",
];

describe("tool classification inventory", () => {
	it("classifies every tool registered by the current Pi startup probe", () => {
		const unknown = REAL_PI_TOOLS.filter((name) => classifyTool(name).intent === "unknown");
		expect(unknown).toEqual([]);
	});

	it("keeps risky network and state-changing tools out of read-only", () => {
		expect(classifyTool("mcpScript").readOnly).toBe(false);
		expect(classifyTool("dbx_dbx_execute_query").readOnly).toBe(false);
		expect(classifyTool("dbx_dbx_list_tables").readOnly).toBe(true);
		expect(classifyTool("orchestration_recover").readOnly).toBe(true);
	});
});
