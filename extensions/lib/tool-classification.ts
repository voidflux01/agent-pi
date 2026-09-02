// ABOUTME: Single source of truth for tool intent classification.
// ABOUTME: Shared by discovery, NORMAL escalation, approval hints, and inspection.

export type ToolIntent = "recon" | "read" | "write" | "execute" | "network" | "agent" | "workflow" | "ui" | "unknown";

export interface ToolClassification {
	intent: ToolIntent;
	readOnly: boolean;
	label: string;
}

export const RECON_TOOL_NAMES = ["read", "grep", "ffgrep", "find", "ls", "glob"] as const;
const RECON_TOOLS = new Set<string>(RECON_TOOL_NAMES);
const WRITE_TOOLS = new Set(["write", "edit", "write_file", "edit_file"]);
const AGENT_TOOLS = new Set(["dispatch_agent", "subagent_create", "subagent_create_batch", "subagent_wait", "subagent_continue", "subagent_remove", "subagent_list"]);
const WORKFLOW_TOOLS = new Set(["tasks", "set_mode", "advance_phase", "dispatch_agents", "pipeline_status", "run_chain", "cycle_memory", "compose_exec", "call_tool", "tool_search"]);
const UI_TOOLS = new Set(["ask_user", "show_plan", "show_file", "show_report", "show_spec"]);
const NETWORK_READ_TOOLS = new Set(["fetch_content", "get_search_content", "security_news", "source_check", "web_search", "network_inspect", "safe_port_scan"]);
const NETWORK_EXECUTE_TOOLS = new Set(["agent_browser", "mcp", "mcpscript"]);
const MEMORY_READ_TOOLS = new Set(["memory_search", "recall"]);
const MEMORY_WRITE_TOOLS = new Set(["memory_correct", "memory_feedback", "memory_store_result", "save_research"]);
const DATABASE_READ_TOOLS = new Set(["dbx_dbx_describe_table", "dbx_dbx_get_schema_context", "dbx_dbx_list_connections", "dbx_dbx_list_tables"]);
const DATABASE_WRITE_TOOLS = new Set(["dbx_dbx_add_connection", "dbx_dbx_close_session", "dbx_dbx_duplicate_connection", "dbx_dbx_execute_and_show", "dbx_dbx_execute_query", "dbx_dbx_execute_redis_command", "dbx_dbx_open_session", "dbx_dbx_open_table", "dbx_dbx_remove_connection"]);
const READ_WORKFLOW_TOOLS = new Set(["orchestration_recover", "orchestration_status", "pipeline_status", "subagent_batch_recover", "team_batch_recover", "resume_handoff"]);
const UI_TOOLS_EXTENDED = new Set(["ask_user_question", "close_viewer", "preview_export", "show_board", "show_cleanup", "show_reports", "show_research", "show_security_report", "show_sounds"]);

const LABELS: Record<ToolIntent, string> = {
	recon: "只读探索",
	read: "只读读取",
	write: "写入修改",
	execute: "命令执行",
	network: "网络/MCP",
	agent: "Agent 编排",
	workflow: "工作流控制",
	ui: "交互展示",
	unknown: "未分类",
};

export function classifyTool(name: string, description = ""): ToolClassification {
	const normalized = name.toLowerCase();
	if (RECON_TOOLS.has(normalized)) return { intent: "recon", readOnly: true, label: LABELS.recon };
	if (WRITE_TOOLS.has(normalized)) return { intent: "write", readOnly: false, label: LABELS.write };
	if (normalized === "bash") return { intent: "execute", readOnly: false, label: LABELS.execute };
	if (normalized.startsWith("mcp__")) return { intent: "network", readOnly: false, label: LABELS.network };
	if (DATABASE_READ_TOOLS.has(normalized)) return { intent: "network", readOnly: true, label: LABELS.network };
	if (DATABASE_WRITE_TOOLS.has(normalized) || normalized.startsWith("dbx_")) return { intent: "network", readOnly: false, label: LABELS.network };
	if (NETWORK_READ_TOOLS.has(normalized)) return { intent: "network", readOnly: true, label: LABELS.network };
	if (NETWORK_EXECUTE_TOOLS.has(normalized)) return { intent: "network", readOnly: false, label: LABELS.network };
	if (MEMORY_READ_TOOLS.has(normalized)) return { intent: "read", readOnly: true, label: LABELS.read };
	if (MEMORY_WRITE_TOOLS.has(normalized)) return { intent: "write", readOnly: false, label: LABELS.write };
	if (READ_WORKFLOW_TOOLS.has(normalized)) return { intent: "workflow", readOnly: true, label: LABELS.workflow };
	if (UI_TOOLS_EXTENDED.has(normalized)) return { intent: "ui", readOnly: true, label: LABELS.ui };
	if (normalized === "debug_capture") return { intent: "ui", readOnly: false, label: LABELS.ui };
	if (normalized === "advisor" || normalized === "ask_parent" || normalized.startsWith("subagent_")) return { intent: "agent", readOnly: false, label: LABELS.agent };
	if (["orchestration_status", "pipeline_status"].includes(normalized)) return { intent: "workflow", readOnly: true, label: LABELS.workflow };
	if (["powershell", "verify_execution"].includes(normalized)) return { intent: "execute", readOnly: false, label: LABELS.execute };
	if (AGENT_TOOLS.has(normalized) || /agent|subagent|dispatch|spawn|worker/.test(normalized)) return { intent: "agent", readOnly: false, label: LABELS.agent };
	if (WORKFLOW_TOOLS.has(normalized) || /pipeline|workflow|phase|chain/.test(normalized)) return { intent: "workflow", readOnly: false, label: LABELS.workflow };
	if (UI_TOOLS.has(normalized)) return { intent: "ui", readOnly: true, label: LABELS.ui };
	const text = `${normalized} ${description}`.toLowerCase();
	if (/https?:\/\/|network|fetch|browser|web search/.test(text)) return { intent: "network", readOnly: false, label: LABELS.network };
	if (/write|edit|delete|remove|install|mutat|create/.test(text)) return { intent: "write", readOnly: false, label: LABELS.write };
	if (/read|inspect|list|find|search|show|view/.test(text)) return { intent: "read", readOnly: true, label: LABELS.read };
	return { intent: "unknown", readOnly: false, label: LABELS.unknown };
}

export function isReconTool(name: string): boolean {
	return classifyTool(name).intent === "recon";
}
