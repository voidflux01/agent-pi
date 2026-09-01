// ABOUTME: Task Board Viewer — opens a GUI browser window showing a live Kanban board of agent work.
// ABOUTME: Shows the local Pi task list in a browser Kanban board.

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { registerToolWithExecutor } from "./lib/tool-executor-registry.ts";
import { Text, type AutocompleteItem } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { outputLine } from "./lib/output-box.ts";
import { applyExtensionDefaults } from "./lib/themeMap.ts";
import { authorizeLocalServerRequest, createLocalServerAuth, type LocalServerAuth } from "./lib/local-server-auth.ts";
import { readBoundedRequestBody } from "./lib/request-body.ts";
import { generateBoardViewerHTML } from "./lib/board-viewer-html.ts";
import { registerActiveViewer, clearActiveViewer, notifyViewerOpen } from "./lib/viewer-session.ts";

// ── Types ────────────────────────────────────────────────────────────

interface BoardResult {
	action: "closed";
}

interface BoardData {
	tasks: any[];
	agents: any[];
	messages: any[];
	groups: any[];
	readyTasks: any[];
	connected: boolean;
	timestamp: string;
	error?: string;
	localMode?: boolean;
	localTitle?: string;
}

const MAX_BOARD_REQUEST_BODY_BYTES = 256 * 1024;

function readRequestBody(req: IncomingMessage, res: ServerResponse, onBody: (body: string) => void): void {
	readBoundedRequestBody(req, res, onBody, MAX_BOARD_REQUEST_BODY_BYTES, { ok: false, error: "Request body too large" });
}

/**
 * Read local tasks from the tasks extension (globalThis.__piTaskList).
 */
function getLocalTasks(): { tasks: any[]; title?: string } {
	const g = globalThis as any;
	const taskList = g.__piTaskList as { tasks: { id: number; text: string; status: string }[]; title?: string; remaining: number; total: number } | undefined;
	const now = new Date().toISOString();
	const statusMap: Record<string, string> = { idle: "pending", inprogress: "working", done: "completed" };

	const tasks = (taskList?.tasks || []).map((t) => ({
		task_id: t.id,
		description: t.text,
		status: statusMap[t.status] || t.status,
		created_at: now,
		updated_at: now,
	}));

	return { tasks, title: taskList?.title };
}

/**
 * Gather board data from the local Pi task list.
 */
async function gatherBoardData(): Promise<BoardData> {
	const local = getLocalTasks();

	// Always return local tasks — this is the local-first board
	return {
		tasks: local.tasks,
		agents: [],
		messages: [],
		groups: [],
		readyTasks: [],
		connected: true,
		localMode: true,
		localTitle: local.title,
		timestamp: new Date().toISOString(),
	};
}

// ── HTTP Server ──────────────────────────────────────────────────────

function startBoardServer(
	title: string,
): Promise<{ port: number; server: Server; waitForResult: () => Promise<BoardResult>; auth: LocalServerAuth }> {
	return new Promise((resolveSetup) => {
		const auth = createLocalServerAuth();
		let resolveResult: (result: BoardResult) => void;
		let settled = false;
		const settle = (result: BoardResult) => {
			if (settled) return;
			settled = true;
			resolveResult!(result);
		};
		const resultPromise = new Promise<BoardResult>((res) => {
			resolveResult = res;
		});

		const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
			const url = new URL(req.url || "/", `http://localhost`);
			if (!authorizeLocalServerRequest(req, res, auth, url)) return;

			// Serve the main HTML page
			if (req.method === "GET" && url.pathname === "/") {
				const port = (server.address() as any)?.port || 0;
				const html = generateBoardViewerHTML({ title, port });
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(html);
				return;
			}

			// Serve the logo image
			if (req.method === "GET" && url.pathname === "/logo.png") {
				try {
					const logoPath = join(dirname(fileURLToPath(import.meta.url)), "assets", "agent-logo.png");
					const logoData = readFileSync(logoPath);
					res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" });
					res.end(logoData);
				} catch {
					res.writeHead(404);
					res.end();
				}
				return;
			}

			// ── Main data endpoint ──────────────────────────────
			if (req.method === "GET" && url.pathname === "/api/board-data") {
				try {
					const data = await gatherBoardData();
					res.writeHead(200, {
						"Content-Type": "application/json",
						"Cache-Control": "no-cache",
					});
					res.end(JSON.stringify(data));
				} catch (err: any) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({
						tasks: [], agents: [], messages: [], groups: [], readyTasks: [],
						connected: false,
						timestamp: new Date().toISOString(),
						error: err.message,
					}));
				}
				return;
			}

			// ── Close the viewer ────────────────────────────────
			if (req.method === "POST" && url.pathname === "/result") {
				readRequestBody(req, res, () => {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true }));
					settle({ action: "closed" });
				});
				return;
			}

			// 404
			res.writeHead(404);
			res.end("Not found");
		});

		server.on("close", () => {
			settle({ action: "closed" });
		});

		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as any;
			resolveSetup({
				port: addr.port,
				server,
				waitForResult: () => resultPromise,
				auth,
			});
		});
	});
}

function openBrowser(url: string): void {
	try {
		execFileSync("open", [url], { stdio: "ignore" });
	} catch {
		try {
			execFileSync("xdg-open", [url], { stdio: "ignore" });
		} catch {
			try {
				execFileSync("cmd.exe", ["/c", "start", "", url], { stdio: "ignore" });
			} catch {}
		}
	}
}

// ── Tool Parameters ──────────────────────────────────────────────────

const ShowBoardParams = Type.Object({
	title: Type.Optional(Type.String({ description: "Title for the board (default: 'Task Board')" })),
});

// ── Extension ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let activeServer: Server | null = null;
	let activeSession: { kind: "board"; title: string; url: string; server: Server; onClose: () => void } | null = null;

	function cleanupServer() {
		const server = activeServer;
		activeServer = null;
		if (server) {
			try { server.close(); } catch {}
		}
		if (activeSession) {
			clearActiveViewer(activeSession);
			activeSession = null;
		}
	}

	// ── Core board launcher ──────────────────────────────────────────

	async function launchBoard(
		ctx: ExtensionContext,
		title: string,
	): Promise<string> {
		// Clean up any previous server
		cleanupServer();

		// Start server
		const { port, server, auth } = await startBoardServer(title);
		activeServer = server;

		const url = `http://127.0.0.1:${port}`;
		const launchUrl = `${url}/?token=${encodeURIComponent(auth.token)}`;
		activeSession = {
			kind: "board",
			title,
			url,
			launchUrl,
			server,
			onClose: () => {
				activeServer = null;
				activeSession = null;
			},
		};
		registerActiveViewer(activeSession);

		// Open the browser
		openBrowser(launchUrl);
		notifyViewerOpen(ctx, activeSession);

		return launchUrl;
	}

	// ── show_board tool ──────────────────────────────────────────────

	registerToolWithExecutor(pi, {
		name: "show_board",
		label: "Show Board",
		description:
			"Open a live task board in the browser. Shows a Kanban-style view of local tasks " +
			"(Pending → Working → Completed → Failed). Auto-refreshes every 3 seconds.\n\n" +
			"The board runs as a lightweight background web server. Unlike other viewers, " +
			"it stays open and keeps refreshing — close the browser tab when done.\n\n" +
			"Shows the local Pi task list in a browser Kanban board.",
		parameters: ShowBoardParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { title = "Task Board" } = params as { title?: string };

			const url = await launchBoard(ctx, title);

			return {
				content: [{
					type: "text" as const,
					text: `Task board opened at ${url}\n\nThe board auto-refreshes every 3 seconds. Close the browser tab when done.\n\nFeatures:\n- Kanban columns: Pending → Working → Completed → Failed\n- Agent chips: click to filter by agent\n- Activity feed: recent mailbox messages\n- Group progress: task group completion bars\n- Keyboard: R=refresh, Esc=clear filter`,
				}],
			};
		},

		renderCall(args, theme) {
			const titleArg = (args as any).title || "Task Board";
			const text =
				theme.fg("toolTitle", theme.bold("show_board ")) +
				theme.fg("accent", titleArg);
			return new Text(outputLine(theme, "accent", text), 0, 0);
		},

		renderResult(result, _options, theme) {
			const text = result.content[0];
			const firstLine = text?.type === "text" ? text.text.split("\n")[0] : "";
			return new Text(
				outputLine(theme, "success", firstLine),
				0, 0,
			);
		},
	});

	// ── /board command ───────────────────────────────────────────────

	pi.registerCommand("board", {
		description: "Open the live task board in the browser; use '/board stop' to shut down",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = [{ value: "stop", label: "stop — shut down the board server" }];
			const normalized = prefix.trim().toLowerCase();
			const matches = items.filter((item) => item.value.startsWith(normalized));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			if (args.trim().toLowerCase() === "stop") {
				if (activeServer) {
					cleanupServer();
					ctx.ui.notify("Task board server stopped.", "info");
				} else {
					ctx.ui.notify("No task board server is running.", "warning");
				}
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("/board requires interactive mode", "error");
				return;
			}

			const title = args.trim() || "Task Board";
			const url = await launchBoard(ctx, title);
			ctx.ui.notify(`Task board opened at ${url}`, "info");
		},
	});

	// ── Session lifecycle ────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
	});

	pi.on("session_shutdown", async () => {
		cleanupServer();
	});
}
