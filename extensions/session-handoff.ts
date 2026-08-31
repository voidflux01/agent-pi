// ABOUTME: Keeps a compact, durable task handoff across new Pi sessions.
// ABOUTME: Restores only a bounded summary on the first turn; full transcripts remain in Pi sessions.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { coordinationState, onCoordinationModeChange } from "./lib/coordination-state.ts";
import { journalPath, type TaskJournalEntry } from "./lib/agent-task-journal.ts";
import {
	buildHandoffSnapshot,
	handoffPath,
	hasMeaningfulHandoff,
	readHandoff,
	renderHandoff,
	renderHandoffPrompt,
	writeHandoff,
	type HandoffSnapshot,
} from "./lib/handoff-state.ts";

const g = globalThis as any;

function cwdOf(ctx: any): string {
	try { return ctx?.cwd || process.cwd(); } catch { return process.cwd(); }
}

function sessionIdOf(ctx: any): string | undefined {
	try { return ctx?.sessionManager?.getSessionId?.() || ctx?.sessionManager?.getSessionFile?.(); } catch { return undefined; }
}

function latestObjective(ctx: any): string {
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

function readChildren(workspace: string): TaskJournalEntry[] {
	try {
		const raw = readFileSync(journalPath(`${workspace}/.pi/agent-sessions`), "utf8");
		const latest = new Map<string, TaskJournalEntry>();
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as TaskJournalEntry;
				if (entry.id) latest.set(entry.id, entry);
			} catch {}
		}
		return [...latest.values()];
	} catch {
		return [];
	}
}

function resumableChildren(workspace: string): TaskJournalEntry[] {
	return readChildren(workspace).filter((child) => !["done", "completed", "success"].includes(child.status));
}

function currentTasks(): Array<{ id: number; text: string; status: string }> {
		return Array.isArray(g.__piTaskList?.tasks) ? g.__piTaskList.tasks : [];
}

function changedFiles(workspace: string): boolean {
	try {
		return Boolean(execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
	} catch { return false; }
}

function snapshotFrom(ctx: any, extra: { parentSessionId?: string; status?: HandoffSnapshot["status"] } = {}): HandoffSnapshot {
	const state = coordinationState();
	const tasks = currentTasks();
	// Completed scouts are historical evidence, not resumable work. Keeping them
	// out of the handoff prevents old reconnaissance from consuming the next
	// session's context; failed/running children remain actionable.
	const children = resumableChildren(cwdOf(ctx));
	const activeTask = tasks.find((task) => task.status === "inprogress");
	const activeChild = children.find((child) => child.status === "running" || child.status === "dispatched" || child.status === "failed" || child.status === "error");
	const receipt = state.verifierReceipt;
	return buildHandoffSnapshot({
		workspace: cwdOf(ctx),
		sessionId: sessionIdOf(ctx),
		parentSessionId: extra.parentSessionId,
		objective: latestObjective(ctx),
		mode: state.mode,
		activeChain: state.activeChain,
		activePipeline: state.activePipeline,
		tasks,
		children,
		nextAction: activeTask?.text || (activeChild ? `${["failed", "error"].includes(activeChild.status) ? "Recover" : "Review"} ${activeChild.agent} result` : undefined),
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

	const persist = (ctx: any, status?: HandoffSnapshot["status"]) => {
		const snapshot = snapshotFrom(ctx, { status });
		if (!hasMeaningfulHandoff(snapshot)) return;
		try { writeHandoff(snapshot.workspace, snapshot); } catch {}
		dirty = false;
		pendingStatus = undefined;
	};
	const schedule = (ctx: any, status?: HandoffSnapshot["status"]) => {
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
				ctx.ui.notify("Task handoff cleared.", "success");
				return;
			}
			if (String(args || "").trim() === "resume") {
				if (!saved) { ctx.ui.notify("No task handoff found for this workspace.", "info"); return; }
				pendingPrompt = saved;
				ctx.ui.notify("Handoff queued for the next turn.", "info");
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

	pi.registerTool({
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
		if (["tasks", "set_mode", "dispatch_agent", "dispatch_agents", "verify_execution", "show_report", "resume_handoff"].includes(event.toolName)) {
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
		const saved = readHandoff(cwdOf(ctx));
		if (saved && saved.status !== "completed" && saved.sessionId !== sessionIdOf(ctx)) {
			pendingPrompt = saved;
			try { ctx.ui?.notify?.(`Unfinished handoff found: ${saved.objective || "unnamed task"}. It will be available to the next turn.`, "warning"); } catch {}
		}
		// A new session is a boundary: preserve the previous session as interrupted.
		if (event?.reason === "new" && saved && saved.status === "in_progress") {
			try { writeHandoff(cwdOf(ctx), { ...saved, status: "interrupted", parentSessionId: event.previousSessionFile || saved.sessionId, updatedAt: new Date().toISOString() }); } catch {}
		}
	});

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
		const saved = readHandoff(cwdOf(ctx));
		if (saved?.status === "completed" && !dirty) return;
		if (dirty || changedFiles(cwdOf(ctx)) || currentTasks().length > 0) persist(ctx, pendingStatus || "in_progress");
	});
}
