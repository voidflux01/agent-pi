// ABOUTME: Interactive Plan Viewer — opens a GUI browser window for markdown plan review.
// ABOUTME: Supports plan mode (approve/edit/reorder) and questions mode (inline answers). Markdown-driven UI.

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { registerToolWithExecutor } from "./lib/tool-executor-registry.ts";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { outputLine } from "./lib/output-box.ts";
import { applyExtensionDefaults } from "./lib/themeMap.ts";
import { generatePlanViewerHTML } from "./lib/plan-viewer-html.ts";
import { createPlanStandaloneExport, saveStandaloneExport } from "./lib/viewer-standalone-export.ts";
import { upsertPersistedReport } from "./lib/report-index.ts";
import { registerActiveViewer, clearActiveViewer, notifyViewerOpen } from "./lib/viewer-session.ts";
import { authorizeLocalServerRequest, createLocalServerAuth, type LocalServerAuth } from "./lib/local-server-auth.ts";
import { markPlanApproved, resetApprovalForMode } from "./lib/approval-gate.ts";
import { bindAcceptanceContract, emptyContract } from "./lib/execution-contract.ts";
import { setExecutionContract } from "./lib/coordination-state.ts";
// Approval is bound to the reviewed snapshot (markPlanApproved() remains the unbound API).

// ── Types ────────────────────────────────────────────────────────────

type ViewerPurpose = "plan" | "questions";

interface ViewerResult {
	action: "approved" | "changes_requested" | "declined" | "submitted";
	markdown: string;
	modified: boolean;
	comments: PlanComment[];
	answers?: string;
	answerMap?: Record<string, string>;
}

interface PlanComment {
	id: string;
	sectionId: string;
	sectionText: string;
	text: string;
	timestamp: string;
}

function planCommentsPath(filePath: string): string {
	return /\.md$/i.test(filePath)
		? filePath.replace(/\.md$/i, "-comments.json")
		: `${filePath}.comments.json`;
}

function formatPlanComments(comments: PlanComment[]): string {
	if (comments.length === 0) return "(no comments)";
	return comments.map((comment) => `- ${comment.sectionText || "(task)"}: ${comment.text}`).join("\n");
}

// ── HTTP Server for GUI Window ───────────────────────────────────────

function startViewerServer(
	markdown: string,
	title: string,
	purpose: ViewerPurpose,
	filePath: string,
	existingComments: PlanComment[] = [],
): Promise<{ port: number; server: Server; waitForResult: () => Promise<ViewerResult>; auth: LocalServerAuth }> {
	return new Promise((resolveSetup) => {
		let resolveResult: (result: ViewerResult) => void;
		const resultPromise = new Promise<ViewerResult>((res) => {
			resolveResult = res;
		});

		const auth = createLocalServerAuth();
		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			const url = new URL(req.url || "/", `http://localhost`);
			if (!authorizeLocalServerRequest(req, res, auth, url)) return;

			// Serve the main HTML page
			if (req.method === "GET" && url.pathname === "/") {
				const port = (server.address() as any)?.port || 0;
				const html = generatePlanViewerHTML({ markdown, title, mode: purpose, port, comments: existingComments });
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

			// Handle result submission (approve/decline)
			if (req.method === "POST" && url.pathname === "/result") {
				let body = "";
				req.on("data", (chunk) => { body += chunk; });
				req.on("end", () => {
					try {
						const data = JSON.parse(body);
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ ok: true }));
						resolveResult!({
							action: data.action || "declined",
							markdown: data.markdown || markdown,
							modified: data.modified || false,
							comments: Array.isArray(data.comments) ? data.comments : [],
							answers: data.answers,
							answerMap: data.answerMap,
						});
					} catch {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "Invalid JSON" }));
					}
				});
				return;
			}

			// Persist comments independently from the plan markdown.
			if (req.method === "POST" && url.pathname === "/save-comments") {
				let body = "";
				req.on("data", (chunk) => { body += chunk; });
				req.on("end", () => {
					try {
						const data = JSON.parse(body || "{}");
						writeFileSync(planCommentsPath(filePath), JSON.stringify({ comments: Array.isArray(data.comments) ? data.comments : [] }, null, 2), "utf-8");
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ ok: true }));
					} catch (err: any) {
						res.writeHead(500, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: err.message }));
					}
				});
				return;
			}

			// Handle save to desktop
			if (req.method === "POST" && url.pathname === "/save") {
				let body = "";
				req.on("data", (chunk) => { body += chunk; });
				req.on("end", () => {
					try {
						const data = JSON.parse(body);
						const desktop = join(homedir(), "Desktop");
						if (!existsSync(desktop)) mkdirSync(desktop, { recursive: true });
						const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
						const fileName = `plan-${ts}.md`;
						const filePath = join(desktop, fileName);
						writeFileSync(filePath, data.markdown, "utf-8");
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ ok: true, message: `Saved to ~/Desktop/${fileName}` }));
					} catch (err: any) {
						res.writeHead(500, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: err.message }));
					}
				});
				return;
			}

			if (req.method === "POST" && url.pathname === "/export-standalone") {
				let body = "";
				req.on("data", (chunk) => { body += chunk; });
				req.on("end", () => {
					try {
						const data = JSON.parse(body);
						const html = createPlanStandaloneExport({
							title,
							markdown: data.markdown || markdown,
							mode: purpose,
						});
						const saved = saveStandaloneExport({ filePrefix: "plan-readonly", html });
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ ok: true, message: `Standalone export saved to ~/Desktop/${saved.fileName}` }));
					} catch (err: any) {
						res.writeHead(500, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: err.message }));
					}
				});
				return;
			}

			// 404 for everything else
			res.writeHead(404);
			res.end("Not found");
		});

		// Listen on random port
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
		// macOS
		execFileSync("open", [url], { stdio: "ignore" });
	} catch {
		try {
			// Linux
			execFileSync("xdg-open", [url], { stdio: "ignore" });
		} catch {
			// Windows fallback
			try {
				execFileSync("cmd.exe", ["/c", "start", "", url], { stdio: "ignore" });
			} catch {
				// Give up silently — URL is logged anyway
			}
		}
	}
}

// ── Tool Parameters ──────────────────────────────────────────────────

const ShowPlanParams = Type.Object({
	file_path: Type.String({ description: "Path to the markdown plan file (e.g. .context/todo.md)" }),
	title: Type.Optional(Type.String({ description: "Title to display in the viewer header" })),
	mode: Type.Optional(Type.String({ description: "Viewer mode: 'plan' (default) for plan review/approval, or 'questions' for follow-up questions with inline answers" })),
});

// ── Extension ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let piRef = pi;

	// Track active servers so we can clean them up
	let activeServer: Server | null = null;
	let activeSession: { kind: ViewerPurpose; title: string; url: string; launchUrl?: string; server: Server; onClose: () => void } | null = null;

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

	// ── Core viewer logic (shared by tool + command) ─────────────────

	async function runViewer(
		ctx: ExtensionContext,
		markdown: string,
		filePath: string,
		title: string,
		purpose: ViewerPurpose,
		signal?: AbortSignal,
	): Promise<ViewerResult> {
		// Clean up any previous server
		cleanupServer();

		// Start HTTP server
		let existingComments: PlanComment[] = [];
		const commentsPath = planCommentsPath(filePath);
		if (purpose === "plan" && existsSync(commentsPath)) {
			try {
				const data = JSON.parse(readFileSync(commentsPath, "utf-8"));
				existingComments = Array.isArray(data.comments) ? data.comments : [];
			} catch {}
		}
		const { port, server, waitForResult, auth } = await startViewerServer(markdown, title, purpose, filePath, existingComments);
		activeServer = server;

		const url = `http://127.0.0.1:${port}`;
		const launchUrl = `${url}/?token=${encodeURIComponent(auth.token)}`;
		activeSession = {
			kind: purpose,
			title: purpose === "questions" ? "Questions viewer" : "Plan viewer",
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
		try {
			piRef.sendMessage({
				customType: "viewer-open",
				content: `${activeSession.title} opened at ${launchUrl}`,
				display: true,
			});
		} catch {}

		// Wait for user action in the browser (or abort)
		try {
			const abortPromise = signal
				? new Promise<ViewerResult>((_, reject) => {
					if (signal.aborted) reject(new Error("Aborted"));
					signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
				})
				: null;

			const result = await (abortPromise
				? Promise.race([waitForResult(), abortPromise])
				: waitForResult());

			// Auto-save the modified markdown back to the source file
			if (result.modified && result.markdown) {
				try {
					writeFileSync(filePath, result.markdown, "utf-8");
				} catch {
					// Silently fail
				}
			}
			if (purpose === "plan") {
				try {
					writeFileSync(commentsPath, JSON.stringify({ comments: result.comments }, null, 2), "utf-8");
				} catch {}
			}

			try {
				upsertPersistedReport({
					category: purpose,
					title,
					summary: result.answers || result.markdown,
					sourcePath: filePath,
					viewerPath: filePath,
					viewerLabel: title,
					tags: [purpose, "markdown"],
					metadata: {
						action: result.action,
						modified: result.modified,
					},
				});
			} catch {
				// Persistence is best-effort; viewer result should still return.
			}

			return result;
		} catch (err: any) {
			if (String(err?.message || err).includes("Aborted")) {
				return { action: "declined", markdown, modified: false, comments: existingComments };
			}
			throw err;
		} finally {
			// Clean up server after result
			cleanupServer();
		}
	}

	function bindApprovedPlanContract(markdown: string): void {
		const bound = bindAcceptanceContract(markdown, "plan");
		setExecutionContract("error" in bound ? emptyContract(markdown, "plan") : bound);
	}

	// ── show_plan tool ───────────────────────────────────────────────

	registerToolWithExecutor(pi, {
		name: "show_plan",
		label: "Show Plan",
		description:
			"Open an interactive markdown viewer overlay. Two modes:\n\n" +
			"**Plan mode** (default): Renders a markdown plan for review. User can edit, " +
			"reorder, toggle checkboxes, and approve or decline. If approved, the tool " +
			"result continues the current turn.\n\n" +
			"**Questions mode** (mode='questions'): Renders markdown containing follow-up " +
			"questions. User can navigate questions, type answers inline, and submit. " +
			"Questions are auto-detected (lines ending with '?' or containing 'Default:'). " +
			"Returns formatted answers.\n\n" +
			"The markdown file IS the UI — update it to change what the user sees.",
		parameters: ShowPlanParams,

		execute: (async (_toolCallId, params, signal, _onUpdate, ctx) => {
			const { file_path, title, mode: modeStr } = params as {
				file_path: string;
				title?: string;
				mode?: string;
			};

			const purpose: ViewerPurpose = modeStr === "questions" ? "questions" : "plan";

			// Read the file
			let markdown: string;
			try {
				markdown = readFileSync(file_path, "utf-8");
			} catch (err: any) {
				return {
					content: [{ type: "text" as const, text: `Error reading file: ${err.message}` }],
				};
			}

			const displayTitle = title || basename(file_path, ".md");

			// A new plan review cycle re-locks implementation until this viewer is approved.
			if (purpose === "plan") resetApprovalForMode("PLAN");

			// Open viewer and wait for result
			const result = await runViewer(ctx, markdown, file_path, displayTitle, purpose, signal);

			// ── Questions mode result ────────────────────────────────
			if (purpose === "questions") {
				if (result.action === "approved" || result.action === "submitted") {
					const answerText = result.answers || "(no answers provided)";

					return {
						content: [{
							type: "text" as const,
							text: `User submitted answers to follow-up questions:\n\n${answerText}`,
						}],
						details: {
							action: "submitted" as const,
							purpose: "questions",
							answers: answerText,
							answerMap: result.answerMap || {},
						},
					};
				}

				return {
					content: [{
						type: "text" as const,
						text: "User closed the questions viewer without submitting answers.",
					}],
					details: {
						action: "declined" as const,
						purpose: "questions",
					},
				};
			}

			// ── Plan mode result ─────────────────────────────────────
			if (result.action === "approved") {
				// markPlanApproved() compatibility spelling; this approval is fingerprint-bound.
				const approvedMarkdown = result.markdown?.trim() ? result.markdown : markdown;
				markPlanApproved(file_path, approvedMarkdown);
				bindApprovedPlanContract(approvedMarkdown);
				const modifiedNote = result.modified
					? " (plan was edited by user — use the updated version)"
					: "";
				const commentNote = result.comments.length > 0
					? `\n\nUser comments (the plan file itself was not changed by these comments):\n${formatPlanComments(result.comments)}`
					: "";

				return {
					content: [{
						type: "text" as const,
						text: `Plan approved! First refresh the task list with concrete implementation steps and mark the first one inprogress. Proceed with implementation.${modifiedNote}\n\nThe updated plan has been saved to ${file_path}.${commentNote}`,
					}],
					details: {
						action: "approved" as const,
						purpose: "plan",
						modified: result.modified,
						filePath: file_path,
					},
				};
			}

			if (result.action === "changes_requested") {
				return {
					content: [{ type: "text" as const, text: `User requested changes to the plan. Comments:\n\n${formatPlanComments(result.comments)}` }],
					details: { action: "changes_requested" as const, comments: result.comments, modified: result.modified, filePath: file_path },
				};
			}

			return {
				content: [{
					type: "text" as const,
					text: "User closed the plan viewer without approving. Ask if they want changes or have feedback.",
				}],
					details: {
						action: "declined" as const,
						comments: result.comments,
					purpose: "plan",
					modified: result.modified,
					filePath: file_path,
				},
			};
			}) as any,

		renderCall(args, theme) {
			const filePath = (args as any).file_path || "?";
			const titleArg = (args as any).title || "";
			const modeArg = (args as any).mode || "plan";
			const modeLabel = modeArg === "questions" ? "questions" : "plan";
			const text =
				theme.fg("toolTitle", theme.bold("show_plan ")) +
				theme.fg("accent", filePath) +
				theme.fg("dim", ` [${modeLabel}]`) +
				(titleArg ? theme.fg("dim", ` — ${titleArg}`) : "");
			return new Text(outputLine(theme, "accent", text), 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as any;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.purpose === "questions") {
				if (details.action === "submitted") {
					return new Text(
						outputLine(theme, "success", "Answers submitted"),
						0, 0,
					);
				}
				return new Text(
					outputLine(theme, "warning", "Questions closed without answers"),
					0, 0,
				);
			}

			if (details.action === "approved") {
				const modNote = details.modified ? " (edited)" : "";
				return new Text(
					outputLine(theme, "success", `Plan approved${modNote}`),
					0, 0,
				);
			}

			return new Text(
				outputLine(theme, "warning", "Plan viewer closed without approval"),
				0, 0,
			);
		},
	});

	// ── /plan command ────────────────────────────────────────────────

	pi.registerCommand("plan", {
		description: "Open the plan viewer for .context/todo.md or a given file",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/plan requires interactive mode", "error");
				return;
			}

			const filePath = args.trim() || join(ctx.cwd, ".context", "todo.md");

			let markdown: string;
			try {
				markdown = readFileSync(filePath, "utf-8");
			} catch {
				ctx.ui.notify(`Cannot read: ${filePath}`, "error");
				return;
			}

			const displayTitle = basename(filePath, ".md");

			resetApprovalForMode("PLAN");
			const result = await runViewer(ctx, markdown, filePath, displayTitle, "plan");

			if (result.action === "approved") {
				// markPlanApproved() compatibility spelling; this approval is fingerprint-bound.
				const approvedMarkdown = result.markdown?.trim() ? result.markdown : markdown;
				markPlanApproved(filePath, approvedMarkdown);
				bindApprovedPlanContract(approvedMarkdown);
				piRef.sendMessage(
					{
						customType: "plan-approved",
						content: `Plan approved! First refresh the task list with concrete implementation steps and mark the first one inprogress. Proceed with implementation.${result.modified ? " (plan was edited)" : ""}`,
						display: true,
					},
					{ deliverAs: "followUp" as any, triggerTurn: true },
				);
				ctx.ui.notify("Plan approved — continuing...", "info");
			} else if (result.modified) {
				ctx.ui.notify("Plan was modified but not approved.", "info");
			}
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
