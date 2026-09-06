// ABOUTME: Keeps a compact, durable task handoff across new Pi sessions.
// ABOUTME: Restores only a bounded summary on the first turn; full transcripts remain in Pi sessions.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerToolWithExecutor } from "./lib/tool-executor-registry.ts";
import { Type } from "@sinclair/typebox";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coordinationState, onCoordinationModeChange } from "./lib/coordination-state.ts";
import { journalList, type TaskJournalEntry } from "./lib/agent-task-journal.ts";
import { isResumableRunStatus, normalizeRunStatus } from "./lib/run-state.ts";
import {
	buildHandoffSnapshot,
	handoffPath,
	hasMeaningfulHandoff,
	readHandoff,
	renderHandoff,
	renderHandoffPrompt,
	writeHandoff,
	type HandoffContextLink,
	type HandoffSnapshot,
} from "./lib/handoff-state.ts";
import type { ObjectiveSource } from "./lib/handoff-state.ts";

const g = globalThis as any;

function cwdOf(ctx: any): string {
	try { return ctx?.cwd || process.cwd(); } catch { return process.cwd(); }
}

function handoffClearMarkerPath(workspace: string): string {
	return `${handoffPath(workspace)}.cleared`;
}

function sessionIdOf(ctx: any): string | undefined {
	try { return ctx?.sessionManager?.getSessionId?.() || ctx?.sessionManager?.getSessionFile?.(); } catch { return undefined; }
}

const MAX_NEXT_ACTION_TASK = 80;

function shortNextAction(value: string): string {
	const trimmed = value.replace(/\s+/g, " ").trim();
	return trimmed.length > MAX_NEXT_ACTION_TASK ? `${trimmed.slice(0, MAX_NEXT_ACTION_TASK - 1)}…` : trimmed;
}

function branchObjective(ctx: any): string {
	try {
		const branch = ctx?.sessionManager?.getBranch?.() || [];
		for (const entry of branch) {
			if (entry?.type !== "message") continue;
			const message = entry.message;
			if (message?.role !== "user") continue;
			const content = Array.isArray(message.content)
				? message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join(" ")
				: typeof message.content === "string" ? message.content : "";
			if (content.trim()) return content.trim();
		}
	} catch {}
	return "";
}

interface SessionStateFile {
	continue?: string;
	task?: string;
}

function readSessionState(workspace: string): SessionStateFile {
	try {
		const parsed = JSON.parse(readFileSync(join(workspace, ".context", "session-state.json"), "utf8")) as SessionStateFile;
		return { continue: parsed?.continue, task: parsed?.task };
	} catch { return {}; }
}

function latestResearchSession(workspace: string): HandoffContextLink["researchSession"] {
	try {
		const dir = join(workspace, ".context", "research-sessions");
		const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as { sessions?: Array<{ id: string; goal?: string; status?: string; updatedAt?: string }> };
		const latest = [...index.sessions ?? []].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))[0];
		if (!latest?.id) return undefined;
		return {
			id: latest.id,
			goal: latest.goal || "(no goal recorded)",
			status: latest.status || "unknown",
			updatedAt: latest.updatedAt || "",
		};
	} catch { return undefined; }
}

function recentReports(workspace: string): string[] {
	try {
		const dir = join(workspace, ".context", "reports");
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((name) => name.endsWith(".md"))
			.map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }))
			.sort((a, b) => b.mtimeMs - a.mtimeMs)
			.slice(0, 3)
			.map((entry) => entry.name);
	} catch { return []; }
}

interface ObjectiveInfo {
	objective: string;
	source?: ObjectiveSource;
}

function resolveObjective(ctx: any, workspace: string): ObjectiveInfo {
	const sessionState = readSessionState(workspace);
	const curated = [sessionState.continue, sessionState.task].find((value) => value?.trim());
	if (curated?.trim()) return { objective: curated.trim(), source: "session-state" };
	const tasks = currentTasks();
	const activeTask = tasks.find((task) => task.status === "inprogress") ?? tasks.find((task) => task.status !== "done");
	if (activeTask?.text?.trim()) return { objective: activeTask.text.trim(), source: "task-list" };
	const research = latestResearchSession(workspace);
	if (research?.goal?.trim() && research.goal !== "(no goal recorded)") return { objective: research.goal.trim(), source: "research" };
	const branch = branchObjective(ctx);
	if (branch) return { objective: branch, source: "branch" };
	return { objective: "" };
}

function resolveContext(workspace: string): HandoffContextLink | undefined {
	const todoPath = join(workspace, ".context", "todo.md");
	const research = latestResearchSession(workspace);
	const context: HandoffContextLink = {
		...(existsSync(todoPath) ? { todoPath } : {}),
		...(research ? { researchSession: research } : {}),
	};
	const reports = recentReports(workspace);
	if (reports.length) context.reports = reports;
	return Object.keys(context).length > 0 ? context : undefined;
}

function readChildren(workspace: string): TaskJournalEntry[] {
	const latest = new Map<string, TaskJournalEntry>();
	for (const entry of journalList(`${workspace}/.pi/agent-sessions`)) {
		if (entry.id) latest.set(entry.id, entry);
	}
	return [...latest.values()];
}

function resumableChildren(workspace: string): TaskJournalEntry[] {
	return readChildren(workspace).filter((child) => isResumableRunStatus(child.runStatus || child.status));
}

function currentTasks(): Array<{ id: number; text: string; status: string }> {
		return Array.isArray(g.__piTaskList?.tasks) ? g.__piTaskList.tasks : [];
}

function snapshotFrom(ctx: any, extra: { parentSessionId?: string; status?: HandoffSnapshot["status"] } = {}): HandoffSnapshot {
	const state = coordinationState();
	const tasks = currentTasks();
	// Completed scouts are historical evidence, not resumable work. Keeping them
	// out of the handoff prevents old reconnaissance from consuming the next
	// session's context; failed/running children remain actionable.
	const children = resumableChildren(cwdOf(ctx));
	const handoffChildren = children.map((child) => ({
		...child,
		status: normalizeRunStatus(child.runStatus || child.status),
	}));
	const workspace = cwdOf(ctx);
	const objective = resolveObjective(ctx, workspace);
	const activeTask = tasks.find((task) => task.status === "inprogress");
	const activeChild = children.find((child) => isResumableRunStatus(child.runStatus || child.status));
	const nextAction = activeTask?.text?.trim()
		? `Continue task #${activeTask.id}: ${shortNextAction(activeTask.text)}`
		: activeChild
			? `${normalizeRunStatus(activeChild.runStatus || activeChild.status) === "failed" ? "Re-dispatch" : "Continue"} ${activeChild.agent} ${activeChild.id}: ${shortNextAction(activeChild.task || "recorded child task")}`
			: undefined;
	const receipt = state.verifierReceipt;
	return buildHandoffSnapshot({
		workspace,
		sessionId: sessionIdOf(ctx),
		parentSessionId: extra.parentSessionId,
		objective: objective.objective,
		objectiveSource: objective.source,
		mode: state.mode,
		activeChain: state.activeChain,
		activePipeline: state.activePipeline,
		tasks,
		children: handoffChildren,
		context: resolveContext(workspace),
		nextAction,
		verification: state.executionContract ? {
			status: receipt?.status || "UNVERIFIED",
			attempt: state.verifierAttempt,
			contractFingerprint: state.executionContract.fingerprint,
		} : undefined,
		status: extra.status,
	});
}

export default function (pi: ExtensionAPI) {
	let pendingPrompt: HandoffSnapshot | undefined;
	let dirty = false;
	let pendingStatus: HandoffSnapshot["status"] | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let clearedThisSession = false;

	const persist = (ctx: any, status?: HandoffSnapshot["status"]) => {
		const snapshot = snapshotFrom(ctx, { status });
		if (!hasMeaningfulHandoff(snapshot)) return;
		if (!status && !dirty) {
			// A caller without an explicit status and without fresh work in this
			// session must never upgrade an acknowledged `interrupted` handoff back
			// to `in_progress`; that is what resurrected repeated startup warnings.
			const existing = readHandoff(snapshot.workspace);
			if (existing?.status === "interrupted") snapshot.status = "interrupted";
		}
		if (existsSync(handoffClearMarkerPath(snapshot.workspace))) return;
		try { writeHandoff(snapshot.workspace, snapshot); } catch {}
		dirty = false;
		pendingStatus = undefined;
	};
	const schedule = (ctx: any, status?: HandoffSnapshot["status"]) => {
		// A later meaningful action starts a fresh handoff lifecycle. This lets a
		// user clear stale work and then begin a genuinely new task in this session.
		clearedThisSession = false;
		try { unlinkSync(handoffClearMarkerPath(cwdOf(ctx))); } catch {}
		dirty = true;
		if (status) pendingStatus = status;
		if (timer) return;
		timer = setTimeout(() => {
			timer = undefined;
			if (dirty) persist(ctx, pendingStatus);
		}, 500);
	};

	pi.registerCommand("handoff", {
		description: "Show the compact task handoff for this workspace",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const options = [
				{ value: "resume", label: "resume", description: "Queue this handoff for the next turn" },
				{ value: "complete", label: "complete", description: "Mark this handoff completed" },
				{ value: "clear", label: "clear", description: "Delete this workspace handoff" },
			];
			const filtered = options.filter((item) => item.value.startsWith(prefix.trim()));
			return filtered.length > 0 ? filtered : null;
		},
			handler: async (args, ctx) => {
			const workspace = cwdOf(ctx);
			const saved = readHandoff(workspace);
			if (String(args || "").trim() === "clear") {
				try { unlinkSync(handoffPath(workspace)); } catch (error: any) {
					if (error?.code !== "ENOENT") { ctx.ui.notify("Could not clear the task handoff.", "error"); return; }
				}
				pendingPrompt = undefined;
				dirty = false;
				pendingStatus = undefined;
				clearedThisSession = true;
				try { writeFileSync(handoffClearMarkerPath(workspace), `${new Date().toISOString()}\n`, { encoding: "utf8", mode: 0o600 }); } catch {}
				ctx.ui.notify("Task handoff cleared.", "success");
				return;
			}
			if (String(args || "").trim() === "resume") {
				if (!saved) { ctx.ui.notify("No task handoff found for this workspace.", "info"); return; }
				pendingPrompt = saved;
				ctx.ui.notify("Resuming task handoff…", "info");
				// A command handler does not itself start an agent turn. Send a small
				// user message so the pending handoff is consumed by
				// before_agent_start immediately instead of appearing to do nothing.
				await pi.sendUserMessage("Continue the unfinished task from the queued handoff. Re-check the workspace and proceed from its next action.");
				return;
			}
			if (String(args || "").trim() === "complete") {
				persist(ctx, "completed");
				ctx.ui.notify("Task handoff marked completed.", "success");
				return;
			}
			if (!saved) { ctx.ui.notify("No task handoff found for this workspace.", "info"); return; }
			ctx.ui.notify(renderHandoff(saved), saved.status === "completed" ? "success" : "warning");
		},
	});

	registerToolWithExecutor(pi, {
		name: "resume_handoff",
		label: "Resume Handoff",
		parameters: Type.Object({}),
		description: "Load the bounded handoff summary from the previous workspace session. Use it when the user asks to continue unfinished work.",
		execute: async (_id, _args, _signal, _update, ctx) => {
			const saved = readHandoff(cwdOf(ctx));
			if (!saved) return { content: [{ type: "text", text: "No resumable handoff found." }] };
			return { content: [{ type: "text", text: renderHandoff(saved) }], details: { handoff: saved } };
		},
	});

	pi.on("tool_result", async (event, ctx) => {
		if (process.env.PI_SUBAGENT === "1") return;
		// resume_handoff is a read operation. It must not make an otherwise idle
		// session dirty, or shutdown will resurrect the handoff as in_progress.
		if (["tasks", "set_mode", "subagent_create", "subagent_create_batch", "verify_execution", "show_report"].includes(event.toolName)) {
			const details = event.result?.details;
			const completed = event.toolName === "show_report" && details?.completionBlocked !== true && details?.error !== true;
			schedule(ctx, completed ? "completed" : undefined);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (process.env.PI_SUBAGENT === "1") return;
		if (dirty) persist(ctx, pendingStatus);
	});

	pi.on("session_start", async (event: any, ctx) => {
		// Child Pi sessions share the workspace with their parent, but their
		// handoff belongs to the parent session. Never consume or mutate it from
		// a SCOUT/TEAM/CHAIN/Pipeline worker.
		if (process.env.PI_SUBAGENT === "1") return;
		markStaleSnapshotInterrupted(ctx, event?.previousSessionFile);
	});

	// /new and session switching must also retire a snapshot owned by the
	// outgoing session, otherwise the live session can keep writing in_progress
	// state for work that no longer belongs to it.
	pi.on("session_switch", async (event: any, ctx) => {
		if (process.env.PI_SUBAGENT === "1") return;
		markStaleSnapshotInterrupted(ctx, event?.previousSessionFile);
	});

	const markStaleSnapshotInterrupted = (ctx: any, previousSessionFile?: string) => {
		const workspace = cwdOf(ctx);
		if (existsSync(handoffClearMarkerPath(workspace))) return;
		const saved = readHandoff(workspace);
		if (!saved || saved.status === "completed" || saved.sessionId === sessionIdOf(ctx)) return;
		pendingPrompt = saved;
		const label = saved.objective || saved.nextAction || saved.tasks[0]?.text || saved.children[0]?.task || "unnamed task";
		if (saved.status === "in_progress") {
			// Downgrade BEFORE notifying: if the write fails, the next startup may
			// warn again, but a successful write guarantees it will not.
			let downgraded = false;
			try {
				writeHandoff(workspace, { ...saved, status: "interrupted", parentSessionId: previousSessionFile || saved.sessionId, updatedAt: new Date().toISOString() });
				downgraded = true;
			} catch {}
			if (downgraded) {
				try { ctx.ui?.notify?.(`Unfinished handoff found: ${label}. It will be available to the next turn.`, "warning"); } catch {}
			}
		}
	};

	const unsubscribeMode = onCoordinationModeChange((_mode, _previous, modeCtx) => {
		// Mode changes are meaningful handoff state even when no mode tool result
		// reaches this extension (for example, a keyboard shortcut changed it).
		if (modeCtx) schedule(modeCtx);
		else dirty = true;
	});

	pi.on("before_agent_start", async () => {
		if (!pendingPrompt) return {};
		const prompt = renderHandoffPrompt(pendingPrompt);
		pendingPrompt = undefined;
		return { systemPrompt: prompt };
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (timer) clearTimeout(timer);
		unsubscribeMode();
		if (clearedThisSession) return;
		if (existsSync(handoffClearMarkerPath(cwdOf(ctx)))) return;
		if (!dirty) {
			// No meaningful action happened in this session. The snapshot on disk
			// belongs to a previous session (its lifecycle already ran); rewriting
			// it here would resurrect an `interrupted` handoff as `in_progress`.
			return;
		}
		persist(ctx, pendingStatus || "in_progress");
	});
}
