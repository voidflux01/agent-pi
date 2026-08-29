// ABOUTME: Task discipline extension. NORMAL lists are strict unless PI_TASKS_STRICT=0.
// ABOUTME: Three-state lifecycle (idle/inprogress/done) with widget display and task validation.
/**
 * Tasks Extension — Task discipline for the agent
 *
 * A task-driven discipline extension. NORMAL mode does not require a task list,
 * but an existing list is strict unless PI_TASKS_STRICT=0. Orchestration modes
 * require an active task before execution. On agent completion, if tasks remain
 * incomplete, the agent gets nudged to continue or mark them done.
 *
 * Three-state lifecycle:  idle → inprogress → done
 *
 * Each list has a title and description that give the tasks a theme.
 * Use `new-list` to start a fresh list. `clear` wipes tasks with user confirm.
 *
 * UI surfaces:
 * - Widget:  prominent "current task" display (the inprogress task)
 * - Status:  compact summary in the status line
 * - /tasks:  interactive overlay with full task details
 *
 * Usage: pi -e extensions/tasks.ts
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { outputLine } from "./lib/output-box.ts";
import { Type } from "@sinclair/typebox";
import { applyExtensionDefaults } from "./lib/themeMap.ts";
import {
	localToCommander,
	parseCommanderTaskId,
	lookupMapping,
	addMapping,
	removeMapping,
	clearMappings,
	emptySyncState,
	shouldCreateGroup,
	isExternalSyncActive,
	markGroupCreationInFlight,
	parseGroupCreateResult,
	buildGroupCreatePayload,
	applyGroupCreateResult,
	updateMappingStatus,
	type SyncState,
} from "./lib/commander-sync.ts";
import { shouldConfirmNewList } from "./lib/tasks-confirm.ts";
import { stripLeadingNumber, renderTaskList, revealIncompleteTasks, type TaskListState } from "./lib/task-list-render.ts";
import { padRight } from "./lib/ui-helpers.ts";
import { enqueueOrExecute } from "./lib/commander-ready.ts";
import { addRetry, isFullySynced } from "./lib/commander-tracker.ts";
import { shouldBypassTaskGate, taskGateStrict, taskRequiredForMode } from "./lib/task-gate.ts";
import { commanderAvailable as isCommanderAvailable, commanderClient, commanderGate, coordinationState } from "./lib/coordination-state.ts";

// Pure gate decision helper (exported for tests). State changes must go through
// the `tasks` tool so they are recorded in the session transcript and survive
// reconstruction/compaction. The gate must never mutate task state implicitly.
export function decideGateClaim(
	all: Array<{ id: number; status: string }>,
	requireTask = false,
): { block: boolean; reason?: string } {
	if (all.length === 0) {
		return requireTask
			? {
				block: true,
				reason: "This mode requires task tracking. You MUST use `tasks new-list` and `tasks add` before using write or execution tools.",
			}
			: { block: false };
	}
	const pending = all.filter((t) => t.status !== "done");
	const active = all.filter((t) => t.status === "inprogress");
	if (pending.length === 0) {
		return {
			block: true,
			reason: "All tasks are done. You MUST use `tasks add` for new tasks or `tasks new-list` to start a fresh list before using any other tools.",
		};
	}
	if (active.length === 0) {
		return {
			block: true,
			reason: "No task is in progress. You MUST use `tasks toggle` to mark a task as inprogress before doing any work.",
		};
	}
	return { block: false };
}

// ── Types ──────────────────────────────────────────────────────────────

type TaskStatus = "idle" | "inprogress" | "done";

interface Task {
	id: number;
	text: string;
	status: TaskStatus;
}

interface TasksDetails {
	action: string;
	tasks: Task[];
	nextId: number;
	listTitle?: string;
	listDescription?: string;
	error?: string;
	syncState?: SyncState;
}

const TasksParams = Type.Object({
	action: StringEnum(["new-list", "add", "toggle", "remove", "update", "list", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Task text (for add/update), or list title (for new-list)" })),
	texts: Type.Optional(Type.Array(Type.String(), { description: "Multiple task texts (for add). Use this to batch-add several tasks at once." })),
	description: Type.Optional(Type.String({ description: "List description (for new-list)" })),
	id: Type.Optional(Type.Number({ description: "Task ID (for toggle/remove/update)" })),
});

// ── Status helpers ─────────────────────────────────────────────────────

const STATUS_ICON: Record<TaskStatus, string> = { idle: "-", inprogress: "*", done: "x" };
const NEXT_STATUS: Record<TaskStatus, TaskStatus> = { idle: "inprogress", inprogress: "done", done: "idle" };
const STATUS_LABEL: Record<TaskStatus, string> = { idle: "idle", inprogress: "in progress", done: "done" };

export interface CurrentTaskInfo { id: number; text: string; commanderTaskId?: number }
export interface TaskListInfo {
	tasks: { id: number; text: string; status: TaskStatus }[];
	title?: string;
	remaining: number;
	total: number;
}

const g = globalThis as any;
function publishCurrentTask(tasks: Task[], sync: SyncState) {
	const cur = tasks.find(t => t.status === "inprogress");
	g.__piCurrentTask = cur ? { id: cur.id, text: cur.text, commanderTaskId: lookupMapping(sync, cur.id) } as CurrentTaskInfo : null;

	const remaining = tasks.filter(t => t.status !== "done").length;
	g.__piTaskList = {
		tasks: tasks.map(t => ({ id: t.id, text: t.text, status: t.status })),
		remaining,
		total: tasks.length,
		__syncState: sync,
	} as TaskListInfo;
}

// ── /tasks overlay component ───────────────────────────────────────────

class TasksListComponent {
	private tasks: Task[];
	private title: string | undefined;
	private desc: string | undefined;
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(tasks: Task[], title: string | undefined, desc: string | undefined, theme: Theme, onClose: () => void) {
		this.tasks = tasks;
		this.title = title;
		this.desc = desc;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const heading = this.title
			? th.fg("accent", ` ${this.title} `)
			: th.fg("accent", " Tasks ");
		const headingLen = this.title ? this.title.length + 2 : 8;
		lines.push(truncateToWidth(
			th.fg("borderMuted", "─".repeat(3)) + heading +
			th.fg("borderMuted", "─".repeat(Math.max(0, width - 3 - headingLen))),
			width,
		));

		if (this.desc) {
			lines.push(truncateToWidth(`  ${th.fg("muted", this.desc)}`, width));
		}
		lines.push("");

		if (this.tasks.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No tasks yet. Ask the agent to add some!")}`, width));
		} else {
			const done = this.tasks.filter((t) => t.status === "done").length;
			const active = this.tasks.filter((t) => t.status === "inprogress").length;
			const idle = this.tasks.filter((t) => t.status === "idle").length;

			lines.push(truncateToWidth(
				"  " +
				th.fg("success", `${done} done`) + th.fg("dim", "  ") +
				th.fg("accent", `${active} active`) + th.fg("dim", "  ") +
				th.fg("muted", `${idle} idle`),
				width,
			));
			lines.push("");

			for (const task of this.tasks) {
				const icon = task.status === "done"
					? th.fg("success", STATUS_ICON.done)
					: task.status === "inprogress"
						? th.fg("accent", STATUS_ICON.inprogress)
						: th.fg("dim", STATUS_ICON.idle);
				const id = th.fg("accent", `#${task.id}`);
				const displayText = stripLeadingNumber(task.text);
				const text = task.status === "done"
					? th.fg("dim", displayText)
					: task.status === "inprogress"
						? th.fg("success", displayText)
						: th.fg("muted", displayText);
				lines.push(truncateToWidth(`  ${icon} ${id} ${text}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ── Extension entry point ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let tasks: Task[] = [];
	let nextId = 1;
	let listTitle: string | undefined;
	let listDescription: string | undefined;
	let nudgedThisCycle = false;
	let syncState: SyncState = emptySyncState();
	// Queue tasks added while the initial Commander group request is in flight.
	let pendingGroupTaskIds: number[] = [];
	let syncGeneration = 0;

	// ── Commander sync (gate-aware) ─────────────────────────────────────

	function syncToCommander(label: string, fn: (client: any) => Promise<void>): void {
		const g = globalThis as any;
		const gate = commanderGate();
		if (!gate) return; // commander-mcp not loaded
		const wrappedFn = async (client: any) => {
			try { await fn(client); }
			catch {
				const tracker = g.__piCommanderTracker;
				if (tracker?._state) {
					tracker._state = addRetry(tracker._state, label, fn);
				}
			}
		};
		enqueueOrExecute(gate, { fn: wrappedFn, label }, commanderClient());
	}

	// ── Snapshot for details ───────────────────────────────────────────

	const makeDetails = (action: string, error?: string): TasksDetails => ({
		action,
		tasks: [...tasks],
		nextId,
		listTitle,
		listDescription,
		syncState: { ...syncState, mappings: [...syncState.mappings] },
		...(error ? { error } : {}),
	});

	// ── UI refresh ─────────────────────────────────────────────────────

	const refreshWidget = (_ctx: ExtensionContext) => {
		publishCurrentTask(tasks, syncState);
	};

	let localTaskListState: TaskListState = { selectedIndex: -1, scrollOffset: 0 };

	const setLocalTaskWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || !ctx.ui) return;
		const published = g.__piTaskList as { tasks: Task[]; title?: string; remaining: number; total: number } | undefined;
		if (!published || published.tasks.length === 0) {
			try { ctx.ui.setWidget("tasks-list", undefined); } catch {}
			return;
		}
		localTaskListState = revealIncompleteTasks(localTaskListState, published.tasks);
		try {
			ctx.ui.setWidget("tasks-list", (tui: any, theme: Theme) => {
				const text = new Text("", 0, 0);
				return {
					render(width: number): string[] {
						const tl = g.__piTaskList as typeof published | undefined;
						if (!tl || tl.tasks.length === 0) {
							text.setText("");
							return [];
						}
						const termHeight = process.stdout.rows || 24;
						const availableHeight = Math.max(3, Math.min(termHeight - 10, 14));
						const taskLines = renderTaskList(
							tl, localTaskListState, width, availableHeight,
							{ truncateToWidth, fg: (c: string, t: string) => theme.fg(c, t) },
						);
						const taskBg = "\x1b[48;5;236m";
						const taskReset = "\x1b[0m";
						const emptyPad = taskBg + padRight("", width) + taskReset;
						const allLines = [emptyPad, ...taskLines.map((line) => taskBg + padRight(line, width) + taskReset), emptyPad];
						text.setText(allLines.join("\n"));
						return allLines;
					},
					invalidate() { text.invalidate(); },
				};
			}, { placement: "aboveEditor" });
		} catch {}
	};

	const refreshUI = (ctx: ExtensionContext) => {
		const syncIndicator = isCommanderAvailable() ? "(synced)" : "(local)";
		if (tasks.length === 0) {
			ctx.ui.setStatus(`Tasks: none ${syncIndicator}`, "tasks");
		} else {
			const remaining = tasks.filter((t) => t.status !== "done").length;
			const label = listTitle ? listTitle : "Tasks";
			ctx.ui.setStatus(`${label}: ${tasks.length} tasks (${remaining} remaining) ${syncIndicator}`, "tasks");
		}

		refreshWidget(ctx);
		if (g.__piTaskList) g.__piTaskList.title = listTitle;
		// agent-team owns the visible task-list widget when loaded. Fall back to a
		// local widget so add/toggle after a completed list still repaints.
		let refreshed = false;
		try {
			if (typeof g.__piRefreshTaskWidget === "function") {
				g.__piRefreshTaskWidget(ctx);
				refreshed = true;
			}
		} catch {}
		if (refreshed) {
			try { ctx.ui.setWidget("tasks-list", undefined); } catch {}
		} else {
			setLocalTaskWidget(ctx);
		}
	};

	// ── State reconstruction from session ──────────────────────────────

	const reconstructState = (ctx: ExtensionContext) => {
		syncGeneration++;
		tasks = [];
		nextId = 1;
		listTitle = undefined;
		listDescription = undefined;
		syncState = emptySyncState();

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "tasks") continue;

			const details = msg.details as TasksDetails | undefined;
			if (details) {
				tasks = Array.isArray(details.tasks) ? details.tasks : [];
				nextId = Number.isSafeInteger(details.nextId) ? details.nextId : nextId;
				listTitle = details.listTitle;
				listDescription = details.listDescription;
				if (details.syncState) {
					syncState = { ...details.syncState, groupCreationInFlight: false };
				}
			}
		}

		refreshUI(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		reconstructState(ctx);
	});
	pi.on("session_switch", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_fork", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	// ── Blocking gate ──────────────────────────────────────────────────

	pi.on("tool_call", async (event, _ctx) => {
		// Sub-agents manage their own task discipline — don't gate them
		if (process.env.PI_SUBAGENT === "1") return { block: false };

		const mode = coordinationState().mode;
		const requiredMode = taskRequiredForMode(mode);
		if (event.toolName === "tasks") return { block: false };
		// In orchestration modes, delegated work is subject to the same hard gate
		// as local write/execution tools. Setup and status tools remain available.
		if (shouldBypassTaskGate(event.toolName, requiredMode, event.arguments || event.params || event.input)) return { block: false };

		// A malformed historical tool result must not crash the extension or
		// create an unrecoverable gate. Reconstruction normalizes this, but keep
		// the boundary defensive for live state as well.
		if (!Array.isArray(tasks)) return { block: false };

		const decision = decideGateClaim(tasks, requiredMode);
		if (!decision.block || requiredMode || taskGateStrict()) return decision;

		// NORMAL with PI_TASKS_STRICT=0 stays advisory so small work is not
		// blocked by task ceremony. Unset or any value other than 0 is strict.
		return {
			block: false,
			reason: `Task suggestion: ${decision.reason} Continue if the task is small or exploratory.`,
		};
	});

	// ── Auto-nudge on agent_end ────────────────────────────────────────

	pi.on("agent_end", async (_event, _ctx) => {
		// Sub-agents are managed by their parent — skip nudge to avoid
		// injecting a user message that can break tool_use/tool_result pairing
		if (process.env.PI_SUBAGENT === "1") return;
		if (!Array.isArray(tasks)) return;

		const incomplete = tasks.filter((t) => t.status !== "done");
		if (incomplete.length === 0 || nudgedThisCycle) return;

		nudgedThisCycle = true;

		const taskList = incomplete
			.map((t) => `  ${STATUS_ICON[t.status]} #${t.id} [${STATUS_LABEL[t.status]}]: ${t.text}`)
			.join("\n");

		pi.sendMessage(
			{
				customType: "task-validation",
				content: `You still have ${incomplete.length} incomplete task(s):\n\n${taskList}\n\nEither continue working on them or mark them done with \`tasks toggle\`. Don't stop until it's done!`,
				display: true,
			},
			{ triggerTurn: true },
		);
	});

	pi.on("input", async () => {
		nudgedThisCycle = false;
		return { action: "continue" as const };
	});

	function syncTasksAddedAfterGroupCreation(localIds: number[], generation: number): void {
		for (const localId of localIds) {
			syncToCommander("task-create-after-group", async (client) => {
				if (generation !== syncGeneration) return;
				const task = tasks.find((candidate) => candidate.id === localId);
				const groupId = syncState.groupId;
				if (!task || groupId === undefined || lookupMapping(syncState, localId) !== undefined) return;
				const res = await client.callTool("commander_task", {
					operation: "create",
					description: task.text,
					working_directory: process.cwd(),
					group_id: groupId,
				});
				const commanderId = parseCommanderTaskId(res);
				if (commanderId === undefined) throw new Error("Commander did not return a task id");
				if (generation !== syncGeneration) return;
				syncState = addMapping(syncState, localId, commanderId);
				syncState = updateMappingStatus(syncState, localId, task.status);
			});
		}
	}

	// ── Register tasks tool ────────────────────────────────────────────

	pi.registerTool({
		name: "tasks",
		label: "Tasks",
		description:
			"Manage the task list. In NORMAL mode a list is optional, but an existing list must have one inprogress task before write or execution tools. " +
			"PI_TASKS_STRICT=0 makes NORMAL advisory. PLAN, SPEC, PIPELINE, TEAM, and CHAIN always require an active task. " +
			"Actions: new-list (text=title, description), add (text or texts[] for batch), toggle (id) — cycles idle→inprogress→done, remove (id), update (id + text), list, clear. " +
			"Always toggle a task to inprogress before starting work on it, and to done when finished. " +
			"Only one task can be inprogress; toggling a second auto-pauses the first. Do not toggle two tasks in the same message. " +
			"Use new-list to start a themed list with a title and description. " +
			"IMPORTANT: If the user's new request does not fit the current list's theme, use clear to wipe the slate and new-list to start fresh.",
		parameters: TasksParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "new-list": {
					if (!params.text) {
						return {
							content: [{ type: "text" as const, text: "Error: text (title) required for new-list" }],
							details: makeDetails("new-list", "text required"),
						};
					}

					// Only confirm if incomplete tasks exist; finished lists clear silently
					if (shouldConfirmNewList(tasks, listTitle)) {
						const confirmed = await ctx.ui.confirm(
							"Start a new list?",
							`This will replace${listTitle ? ` "${listTitle}"` : " the current list"} (${tasks.length} task(s)). Continue?`,
							{ timeout: 30000 },
						);
						if (!confirmed) {
							return {
								content: [{ type: "text" as const, text: "New list cancelled by user." }],
								details: makeDetails("new-list", "cancelled"),
							};
						}
					}

					// Cancel any previously synced tasks before resetting
					if (syncState.mappings.length > 0) {
						const mappingsToCancel = [...syncState.mappings];
						syncToCommander("cancel-old-list", async (client) => {
							for (const m of mappingsToCancel) {
								await client.callTool("commander_task", { operation: "update", task_id: m.commanderId, status: "cancelled" });
							}
						});
					}

					tasks = [];
					nextId = 1;
					listTitle = params.text;
					listDescription = params.description || undefined;
					syncState = emptySyncState();
					syncGeneration++;
					pendingGroupTaskIds = [];

					// Group creation deferred to first `add` — avoids empty tasks[] rejection

					const result = {
						content: [{
							type: "text" as const,
							text: `New list: "${listTitle}"${listDescription ? ` — ${listDescription}` : ""}`,
						}],
						details: makeDetails("new-list"),
					};
					refreshUI(ctx);
					return result;
				}

				case "list": {
					const header = listTitle ? `${listTitle}:` : "";
					const result = {
						content: [{
							type: "text" as const,
							text: tasks.length
								? (header ? header + "\n" : "") +
									tasks.map((t) => `[${STATUS_ICON[t.status]}] #${t.id} (${t.status}): ${t.text}`).join("\n")
								: "No tasks defined yet.",
						}],
						details: makeDetails("list"),
					};
					refreshUI(ctx);
					return result;
				}

				case "add": {
					const items = params.texts?.length ? params.texts : params.text ? [params.text] : [];
					if (items.length === 0) {
						return {
							content: [{ type: "text" as const, text: "Error: text or texts required for add" }],
							details: makeDetails("add", "text required"),
						};
					}
					const added: Task[] = [];
					for (const item of items) {
						const t: Task = { id: nextId++, text: item, status: "idle" };
						tasks.push(t);
						added.push(t);
					}

					// Sync: create Commander tasks (skip if external sync owns it)
					if (!isExternalSyncActive()) {
						const generation = syncGeneration;
						if (shouldCreateGroup(syncState)) {
							// Path A: no group yet — batch all tasks into a single group:create
							syncState = markGroupCreationInFlight(syncState);
							const localIds = added.map((t) => t.id);
							const payload = buildGroupCreatePayload(
								listTitle || "Tasks",
								listDescription || listTitle || "Tasks",
								added.map((t) => t.text),
								process.cwd(),
							);
							syncToCommander("group-create", async (client) => {
								if (generation !== syncGeneration) return;
								const res = await client.callTool("commander_task", payload);
								const parsed = parseGroupCreateResult(res);
								if (generation !== syncGeneration) return;
								if (parsed) {
									syncState = applyGroupCreateResult(syncState, localIds, parsed);
									for (const lid of localIds) {
										syncState = updateMappingStatus(syncState, lid, "idle");
									}
									const queuedIds = pendingGroupTaskIds.splice(0);
									syncTasksAddedAfterGroupCreation(queuedIds, generation);
								} else {
									// Keep locally-created tasks recoverable when the first group request
									// fails. Rebuild the group from every currently unmapped task.
									syncState = { ...syncState, groupCreationInFlight: false };
									const retryTasks = tasks.filter(t => lookupMapping(syncState, t.id) === undefined);
									pendingGroupTaskIds = [];
									if (retryTasks.length > 0 && generation === syncGeneration) {
										syncState = markGroupCreationInFlight(syncState);
										const retryIds = retryTasks.map(t => t.id);
										const retryPayload = buildGroupCreatePayload(listTitle || "Tasks", listDescription || listTitle || "Tasks", retryTasks.map(t => t.text), process.cwd());
										syncToCommander("group-create-retry", async (retryClient) => {
											const retryRes = await retryClient.callTool("commander_task", retryPayload);
											const retryParsed = parseGroupCreateResult(retryRes);
											if (!retryParsed) throw new Error("Commander group retry returned no tasks");
											syncState = applyGroupCreateResult(syncState, retryIds, retryParsed);
										});
									}
								}
								try { refreshUI(ctx); } catch {}
							});
						} else if (syncState.groupId !== undefined) {
							// Path B: group exists — add individual tasks with group_id
							for (const t of added) {
								syncToCommander("task-create", async (client) => {
									if (generation !== syncGeneration) return;
									const res = await client.callTool("commander_task", {
										operation: "create",
										description: t.text,
										working_directory: process.cwd(),
										group_id: syncState.groupId,
									});
									const cid = parseCommanderTaskId(res);
									if (generation !== syncGeneration) return;
									if (cid !== undefined) {
										syncState = addMapping(syncState, t.id, cid);
										syncState = updateMappingStatus(syncState, t.id, "idle");
										try { refreshUI(ctx); } catch {}
									}
								});
							}
						} else if (syncState.groupCreationInFlight) {
							pendingGroupTaskIds.push(...added.map((task) => task.id));
						}
					}

					const msg = added.length === 1
						? `Added task #${added[0].id}: ${added[0].text}`
						: `Added ${added.length} tasks: ${added.map((t) => `#${t.id}`).join(", ")}`;
					const result = {
						content: [{ type: "text" as const, text: msg }],
						details: makeDetails("add"),
					};
					refreshUI(ctx);
					return result;
				}

				case "toggle": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: id required for toggle" }],
							details: makeDetails("toggle", "id required"),
						};
					}
					const task = tasks.find((t) => t.id === params.id);
					if (!task) {
						return {
							content: [{ type: "text" as const, text: `Task #${params.id} not found` }],
							details: makeDetails("toggle", `#${params.id} not found`),
						};
					}
					const prev = task.status;
					task.status = NEXT_STATUS[task.status];

					// Enforce single inprogress — demote any other active task
					const demoted: Task[] = [];
					if (task.status === "inprogress") {
						for (const t of tasks) {
							if (t.id !== task.id && t.status === "inprogress") {
								t.status = "idle";
								demoted.push(t);
							}
						}
					}

					let msg = `Task #${task.id}: ${prev} → ${task.status}`;
					if (demoted.length > 0) {
						msg += `\n(Auto-paused ${demoted.map((t) => `#${t.id}`).join(", ")} → idle. Only one task can be in progress at a time.)`;
					}

					// Sync: update Commander task status (skip if external sync owns it)
					if (!isExternalSyncActive()) {
						const gate = commanderGate();
						const client = commanderClient();

						if (gate?.state === "available" && client) {
							// Commander available: await sync for per-task verification
							const cid = lookupMapping(syncState, task.id);
							if (cid !== undefined) {
								try {
									await client.callTool("commander_task", {
										operation: "update",
										task_id: cid,
										status: localToCommander(task.status),
									});
									syncState = updateMappingStatus(syncState, task.id, task.status);
									msg += ` (Commander #${cid} → ${localToCommander(task.status)})`;
								} catch {
									// Direct sync failed — queue for retry
									syncToCommander("task-toggle-retry", async (c) => {
										await c.callTool("commander_task", {
											operation: "update",
											task_id: cid,
											status: localToCommander(task.status),
										});
										syncState = updateMappingStatus(syncState, task.id, task.status);
									});
									msg += ` (Commander sync failed — queued for retry)`;
								}
							} else {
								msg += ` (Commander: no mapping for task #${task.id})`;
							}

							// On completion: verify all tasks are synced
							if (task.status === "done") {
								const synced = isFullySynced(
									tasks.map(t => ({ id: t.id, text: t.text, status: t.status })),
									syncState.mappings,
								);
								if (!synced) {
									const tracker = g.__piCommanderTracker;
									if (tracker?.reconcileNow) tracker.reconcileNow();
									msg += "\n(Triggering Commander sync for remaining tasks)";
								}
							}
						} else {
							// Commander unavailable: fire-and-forget (existing behavior)
							syncToCommander("task-toggle", async (client) => {
								const cid = lookupMapping(syncState, task.id);
								if (cid === undefined) return;
								await client.callTool("commander_task", {
									operation: "update",
									task_id: cid,
									status: localToCommander(task.status),
								});
								syncState = updateMappingStatus(syncState, task.id, task.status);
							});
						}

						// Demoted tasks: fire-and-forget (automatic side effect)
						for (const d of demoted) {
							syncToCommander("task-demote", async (client) => {
								const cid = lookupMapping(syncState, d.id);
								if (cid === undefined) return;
								await client.callTool("commander_task", {
									operation: "update",
									task_id: cid,
									status: "pending",
								});
								syncState = updateMappingStatus(syncState, d.id, "idle");
							});
						}
					}

					const result = {
						content: [{
							type: "text" as const,
							text: msg,
						}],
						details: makeDetails("toggle"),
					};
					refreshUI(ctx);
					return result;
				}

				case "remove": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: id required for remove" }],
							details: makeDetails("remove", "id required"),
						};
					}
					const idx = tasks.findIndex((t) => t.id === params.id);
					if (idx === -1) {
						return {
							content: [{ type: "text" as const, text: `Task #${params.id} not found` }],
							details: makeDetails("remove", `#${params.id} not found`),
						};
					}
					const removed = tasks.splice(idx, 1)[0];
					pendingGroupTaskIds = pendingGroupTaskIds.filter((localId) => localId !== removed.id);

					// Sync: cancel Commander task (skip if external sync owns it)
					if (!isExternalSyncActive()) {
						const removedCommanderId = lookupMapping(syncState, removed.id);
						syncToCommander("task-remove", async (client) => {
							const cid = removedCommanderId;
							if (cid === undefined) return;
							await client.callTool("commander_task", {
								operation: "update",
								task_id: cid,
								status: "cancelled",
							});
						});
					}
					syncState = removeMapping(syncState, removed.id);

					const result = {
						content: [{ type: "text" as const, text: `Removed task #${removed.id}: ${removed.text}` }],
						details: makeDetails("remove"),
					};
					refreshUI(ctx);
					return result;
				}

				case "update": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: id required for update" }],
							details: makeDetails("update", "id required"),
						};
					}
					if (!params.text) {
						return {
							content: [{ type: "text" as const, text: "Error: text required for update" }],
							details: makeDetails("update", "text required"),
						};
					}
					const toUpdate = tasks.find((t) => t.id === params.id);
					if (!toUpdate) {
						return {
							content: [{ type: "text" as const, text: `Task #${params.id} not found` }],
							details: makeDetails("update", `#${params.id} not found`),
						};
					}
					const oldText = toUpdate.text;
					toUpdate.text = params.text;
					if (!isExternalSyncActive()) {
						const commanderId = lookupMapping(syncState, toUpdate.id);
						if (commanderId !== undefined) {
							syncToCommander("task-update", async (client) => {
								await client.callTool("commander_task", { operation: "update", task_id: commanderId, description: toUpdate.text });
							});
						}
					}
					const result = {
						content: [{ type: "text" as const, text: `Updated #${toUpdate.id}: "${oldText}" → "${toUpdate.text}"` }],
						details: makeDetails("update"),
					};
					refreshUI(ctx);
					return result;
				}

				case "clear": {
					if (shouldConfirmNewList(tasks, listTitle)) {
						const confirmed = await ctx.ui.confirm(
							"Clear task list?",
							`This will remove all ${tasks.length} task(s)${listTitle ? ` from "${listTitle}"` : ""}. Continue?`,
							{ timeout: 30000 },
						);
						if (!confirmed) {
							return {
								content: [{ type: "text" as const, text: "Clear cancelled by user." }],
								details: makeDetails("clear", "cancelled"),
							};
						}
					}

					const count = tasks.length;

					// Sync: cancel all mapped Commander tasks (skip if external sync owns it)
					if (!isExternalSyncActive() && syncState.mappings.length > 0) {
						const mappingsToCancel = [...syncState.mappings];
						syncToCommander("cancel-all", async (client) => {
							for (const m of mappingsToCancel) {
								await client.callTool("commander_task", {
									operation: "update",
									task_id: m.commanderId,
									status: "cancelled",
								});
							}
						});
					}

					tasks = [];
					nextId = 1;
					syncGeneration++;
					pendingGroupTaskIds = [];
					listTitle = undefined;
					listDescription = undefined;
					syncState = clearMappings(syncState);

					const result = {
						content: [{ type: "text" as const, text: `Cleared ${count} task(s)` }],
						details: makeDetails("clear"),
					};
					refreshUI(ctx);
					return result;
				}

				default:
					return {
						content: [{ type: "text" as const, text: `Unknown action: ${params.action}` }],
						details: makeDetails("list", `unknown action: ${params.action}`),
					};
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("tasks ")) + theme.fg("muted", args.action);
			if (args.texts?.length) text += ` ${theme.fg("dim", `${args.texts.length} tasks`)}`;
			else if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.description) text += ` ${theme.fg("dim", `— ${args.description}`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			return new Text(outputLine(theme, "accent", text), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TasksDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(outputLine(theme, "error", `Error: ${details.error}`), 0, 0);
			}

			const taskList = details.tasks;

			switch (details.action) {
				case "new-list": {
					let msg = theme.fg("success", "New list ") + theme.fg("accent", `"${details.listTitle}"`);
					if (details.listDescription) {
						msg += theme.fg("dim", ` — ${details.listDescription}`);
					}
					return new Text(outputLine(theme, "success", msg), 0, 0);
				}

				case "list": {
					if (taskList.length === 0) return new Text(outputLine(theme, "accent", "No tasks"), 0, 0);

					let listText = "";
					if (details.listTitle) {
						listText += theme.fg("accent", details.listTitle) + theme.fg("dim", "  ");
					}
					listText += theme.fg("muted", `${taskList.length} task(s):`);
					const display = expanded ? taskList : taskList.slice(0, 5);
					for (const t of display) {
						const icon = t.status === "done"
							? theme.fg("success", STATUS_ICON.done)
							: t.status === "inprogress"
								? theme.fg("accent", STATUS_ICON.inprogress)
								: theme.fg("dim", STATUS_ICON.idle);
						const itemDisplayText = stripLeadingNumber(t.text);
						const itemText = t.status === "done"
							? theme.fg("dim", itemDisplayText)
							: t.status === "inprogress"
								? theme.fg("success", itemDisplayText)
								: theme.fg("muted", itemDisplayText);
						listText += `\n${icon} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
					}
					if (!expanded && taskList.length > 5) {
						listText += `\n${theme.fg("dim", `... ${taskList.length - 5} more`)}`;
					}
					return new Text(outputLine(theme, "accent", listText), 0, 0);
				}

				case "add": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(outputLine(theme, "success", msg), 0, 0);
				}

				case "toggle": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(outputLine(theme, "accent", msg), 0, 0);
				}

				case "remove": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(outputLine(theme, "warning", msg), 0, 0);
				}

				case "update": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(outputLine(theme, "success", msg), 0, 0);
				}

				case "clear":
					return new Text(outputLine(theme, "success", "Cleared all tasks"), 0, 0);

				default:
					return new Text(outputLine(theme, "dim", "done"), 0, 0);
			}
		},
	});

	// ── /tasks command ────────────────────────────────────────────────

	pi.registerCommand("tasks", {
		description: "Show all Tasks tasks on the current branch",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/tasks requires interactive mode", "error");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TasksListComponent(tasks, listTitle, listDescription, theme, () => done());
			});
		},
	});
}
