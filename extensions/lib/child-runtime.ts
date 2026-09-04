// ABOUTME: Builds a least-privilege environment for delegated Pi workers.
// ABOUTME: Keeps runtime basics while preventing accidental propagation of API keys and session secrets.

import { classifyTool, type ToolIntent } from "./tool-classification.ts";

const SAFE_ENV_NAMES = new Set([
	"HOME", "PATH", "SHELL", "TERM", "COLORTERM", "LANG", "TMPDIR", "TMP", "TEMP",
	"PWD", "USER", "LOGNAME", "NO_COLOR", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
	"HERDR_BIN_PATH", "HERDR_DONE_PATH", "HERDR_ENV", "HERDR_SESSION", "HERDR_SOCKET_PATH",
	"HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID",
]);

/** Parent Pi home/package paths. omp/prime honor these and would load ~/.pi/agent. */
const PARENT_PI_STATE = new Set(["PI_CODING_AGENT_DIR", "PI_PACKAGE_DIR"]);

/**
 * Do not pass the parent's complete environment to a child agent. Provider keys
 * and OAuth/session secrets are intentionally excluded. An explicit opt-in is
 * available for installations that cannot use Pi's on-disk auth configuration.
 */
export function childEnvironment(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
	const allowName = (name: string) => {
		if (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)$/i.test(name)) return false;
		if (PARENT_PI_STATE.has(name) || name === "PI_CHILD_INHERIT_ENV") return false;
		return SAFE_ENV_NAMES.has(name) || name.startsWith("LC_") || name.startsWith("PI_");
	};
	const inherited = process.env.PI_CHILD_INHERIT_ENV === "1"
		? { ...process.env }
		: Object.fromEntries(Object.entries(process.env).filter(([name]) => allowName(name)));
	// Overrides are explicit per-child configuration (for example a narrowly scoped
	// JIRA token for an external integration), so do not silently discard them.
	return { ...inherited, ...overrides };
}

/** Add a parent-communication extension tool without disturbing agent tool policy. */
export function ensurePiTool(tools: string, toolName: string): string {
	const names = tools.split(",").map((name) => name.trim()).filter(Boolean);
	return names.includes(toolName) ? names.join(",") : [...names, toolName].join(",");
}

export interface ParentToolMetadata { name: string; description?: string }
export type WorkerToolPolicy = "readonly" | "recon" | "execution";

/** Project only safe parent capabilities into a child worker. */
export function projectWorkerTools(
	declaredTools: string,
	parentTools: readonly ParentToolMetadata[] = [],
	policy: WorkerToolPolicy = "readonly",
): string {
	const declared = declaredTools.split(",").map((name) => name.trim()).filter(Boolean);
	const allowed = (name: string): boolean => {
		if (policy === "execution") return true;
		const intent = classifyTool(name).intent;
		// Recon workers are deliberately denied shell, write, network, and
		// workflow tools. Research web tools are added explicitly by callers.
		if (policy === "recon") return intent === "read" || intent === "recon";
		// Review-only workers may run bounded checks through their declared bash
		// tool, but cannot receive write/network/workflow capabilities.
		return intent === "read" || intent === "recon" || name === "bash";
	};
	const result = declared.filter(allowed);
	const have = new Set(result);
	const readIntents = new Set<ToolIntent>(["read", "recon"]);
	for (const tool of parentTools) {
		const name = String(tool.name || "").trim();
		if (!name || have.has(name)) continue;
		const classification = classifyTool(name, tool.description || "");
		if (readIntents.has(classification.intent)) {
			result.push(name);
			have.add(name);
		}
	}
	// Bash is an execution-capable tool, so it is inherited only by workers
	// whose role explicitly permits bounded read-only shell inspection.
	if (policy === "recon" && parentTools.some((tool) => tool.name === "bash") && !have.has("bash")) result.push("bash");
	return result.join(",");
}
