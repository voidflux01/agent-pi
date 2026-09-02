// ABOUTME: Research sessions browser for autoresearch lifecycle tracking.
// ABOUTME: Opens a web viewer to browse, search, and resume saved research sessions.

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { registerToolWithExecutor } from "./lib/tool-executor-registry.ts";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { outputLine } from "./lib/output-box.ts";
import { applyExtensionDefaults } from "./lib/themeMap.ts";
import { authorizeLocalServerRequest, createLocalServerAuth, type LocalServerAuth } from "./lib/local-server-auth.ts";
import { generateResearchViewerHTML } from "./lib/research-viewer-html.ts";
import {
	listResearchSessions,
	loadResearchSession,
	listResearchSessionsFull,
	createResearchSession,
	saveResearchSession,
	type ResearchSessionSummary,
	type WebResearchRecord,
} from "./lib/research-session.ts";

function openBrowser(url: string): void {
	try { execFileSync("open", [url], { stdio: "ignore" }); } catch {
		try { execFileSync("xdg-open", [url], { stdio: "ignore" }); } catch {
			try { execFileSync("cmd.exe", ["/c", "start", "", url], { stdio: "ignore" }); } catch {}
		}
	}
}

function startResearchServer(title: string): Promise<{ port: number; server: Server; waitForResult: () => Promise<void>; auth: LocalServerAuth }> {
	return new Promise((resolveSetup) => {
		const auth = createLocalServerAuth();
		let resolveResult: () => void;
		const resultPromise = new Promise<void>((res) => { resolveResult = res; });
		let lastHeartbeat = Date.now();
		const heartbeatCheck = setInterval(() => {
			if (Date.now() - lastHeartbeat > 15_000) {
				clearInterval(heartbeatCheck);
				resolveResult!();
			}
		}, 5_000);

		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			const url = new URL(req.url || "/", "http://localhost");
			if (!authorizeLocalServerRequest(req, res, auth, url)) return;

			// Main page
			if (req.method === "GET" && url.pathname === "/") {
				const port = (server.address() as any)?.port || 0;
				const sessions = listResearchSessions();
				const html = generateResearchViewerHTML({ title, port, sessions });
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(html);
				return;
			}

			// Logo
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

			// Heartbeat
			if (req.method === "POST" && url.pathname === "/heartbeat") {
				lastHeartbeat = Date.now();
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
				return;
			}

			// API: List all sessions (summaries)
			if (req.method === "GET" && url.pathname === "/api/sessions") {
				const sessions = listResearchSessions();
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(sessions));
				return;
			}

			// API: Get single session (full detail)
			if (req.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
				let id = "";
				try { id = decodeURIComponent(url.pathname.slice("/api/sessions/".length)); } catch {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Invalid session id" }));
					return;
				}
				const session = loadResearchSession(id);
				if (session) {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify(session));
				} else {
					res.writeHead(404, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Session not found" }));
				}
				return;
			}

			// Close
			if (req.method === "POST" && url.pathname === "/result") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
				resolveResult!();
				return;
			}

			res.writeHead(404);
			res.end("Not found");
		});
		server.on("close", () => clearInterval(heartbeatCheck));

		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as any;
			resolveSetup({
				port: addr.port,
				server,
				waitForResult: () => resultPromise.finally(() => clearInterval(heartbeatCheck)),
				auth,
			});
		});
	});
}

const ShowResearchParams = Type.Object({
	title: Type.Optional(Type.String({ description: "Title for the research browser view" })),
	session_id: Type.Optional(Type.String({ description: "Open directly to a specific session's detail view" })),
});

const SaveResearchParams = Type.Object({
	goal: Type.String({ description: "The research goal" }),
	query: Type.String({ description: "The query or research question" }),
	findings: Type.String({ description: "Source-backed findings and downstream implications" }),
	verified_facts: Type.Optional(Type.String()),
	uncertainty: Type.Optional(Type.String()),
	failures: Type.Optional(Type.String()),
	sources: Type.Optional(Type.Array(Type.Object({
		url: Type.String(),
		title: Type.Optional(Type.String()),
		retrievedAt: Type.String(),
		type: Type.Optional(Type.String()),
	}))),
});

export default function (pi: ExtensionAPI) {
	let activeServer: Server | null = null;
	function cleanupServer() {
		if (activeServer) {
			try { activeServer.close(); } catch {}
			activeServer = null;
		}
	}

	async function runViewer(ctx: ExtensionContext, title: string) {
		cleanupServer();
		const { port, server, waitForResult, auth } = await startResearchServer(title);
		activeServer = server;
		const url = `http://127.0.0.1:${port}`;
		const launchUrl = `${url}/?token=${encodeURIComponent(auth.token)}`;
		openBrowser(launchUrl);
		if (ctx.hasUI) ctx.ui.notify(`Research browser opened at ${launchUrl}`, "info");
		try {
			await waitForResult();
		} finally {
			cleanupServer();
		}
	}

	// ── show_research tool ───────────────────────────────────────────

	registerToolWithExecutor(pi, {
		name: "save_research",
		label: "Save Research",
		description: "Persist a source-backed web research report in the research session store.",
		parameters: SaveResearchParams,
		async execute(_toolCallId, params) {
			const p = params as {
				goal: string; query: string; findings: string; verified_facts?: string;
				uncertainty?: string; failures?: string; sources?: WebResearchRecord["sources"];
			};
			const session = createResearchSession(p.goal);
			// save_research is called after the researcher has returned a complete
			// report; keeping this as "researching" makes finished reports appear
			// permanently active in the viewer.
			session.status = "complete";
			session.findings = p.findings;
			session.webResearch = {
				query: p.query,
				sources: p.sources || [],
				verifiedFacts: p.verified_facts || "",
				uncertainty: p.uncertainty || "",
				failures: p.failures || "",
			};
			saveResearchSession(session);
			return { content: [{ type: "text" as const, text: `Saved research session ${session.id}` }] };
		},
		renderCall(args, theme) {
			return new Text(outputLine(theme, "accent", theme.fg("toolTitle", theme.bold("save_research ")) + theme.fg("accent", (args as any).goal || "research")), 0, 0);
		},
	});

	registerToolWithExecutor(pi, {
		name: "show_research",
		label: "Show Research",
		description:
			"Open the research sessions browser. Browse, search, and resume saved autoresearch sessions.\n\n" +
			"Each session tracks the full lifecycle: goal → clarifying questions → plan → research iterations → findings → implementation.",
		parameters: ShowResearchParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const p = params as { title?: string; session_id?: string };
			await runViewer(ctx, p.title || "Research Sessions");
			return { content: [{ type: "text" as const, text: "Research browser closed." }] };
		},
		renderCall(args, theme) {
			const text = theme.fg("toolTitle", theme.bold("show_research ")) + theme.fg("accent", (args as any).title || "Research Sessions");
			return new Text(outputLine(theme, "accent", text), 0, 0);
		},
	});

	// ── /research command ────────────────────────────────────────────

	pi.registerCommand("research", {
		description: "Run a research task or open the research sessions browser",
		handler: async (args, ctx) => {
			const task = String(args || "").trim();
			if (task) {
				await pi.sendUserMessage(`Research this request using the researcher agent, save the source-backed report, and return the findings:\n\n${task}`);
				return;
			}
			await runViewer(ctx, "Research Sessions");
		},
	});

	// ── Lifecycle ────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
	});

	pi.on("session_shutdown", async () => {
		cleanupServer();
	});
	pi.on("session_switch", async () => {
		cleanupServer();
	});
}
