// ABOUTME: Interactive Plan Viewer — opens a GUI browser window for markdown plan review.
// ABOUTME: Supports plan mode (approve/edit/reorder) and questions mode (inline answers). Markdown-driven UI.

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { outputLine } from "./lib/output-box.ts";
import { applyExtensionDefaults } from "./lib/themeMap.ts";
import { generatePlanViewerHTML } from "./lib/plan-viewer-html.ts";
import { createPlanStandaloneExport, saveStandaloneExport } from "./lib/viewer-standalone-export.ts";
import { upsertPersistedReport } from "./lib/report-index.ts";
import { registerActiveViewer, clearActiveViewer, notifyViewerOpen } from "./lib/viewer-session.ts";
import { armGrillSession, grillStatePath, readGrillState, recordGrillTurn, saveGrillResults, type GrillTurn } from "./lib/grill-core.ts";

// ── Types ────────────────────────────────────────────────────────────

type ViewerPurpose = "plan" | "questions";

interface ViewerResult {
	action: "approved" | "declined" | "submitted";
	markdown: string;
	modified: boolean;
	answers?: string;
	answerMap?: Record<string, string>;
}

// ── HTTP Server for GUI Window ───────────────────────────────────────

function startViewerServer(
	markdown: string,
	title: string,
	purpose: ViewerPurpose,
): Promise<{ port: number; server: Server; waitForResult: () => Promise<ViewerResult> }> {
	return new Promise((resolveSetup) => {
		let resolveResult: (result: ViewerResult) => void;
		const resultPromise = new Promise<ViewerResult>((res) => {
			resolveResult = res;
		});

		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			// CORS headers for local dev
			res.setHeader("Access-Control-Allow-Origin", "*");
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
			res.setHeader("Access-Control-Allow-Headers", "Content-Type");

			if (req.method === "OPTIONS") {
				res.writeHead(204);
				res.end();
				return;
			}

			const url = new URL(req.url || "/", `http://localhost`);

			// Serve the main HTML page
			if (req.method === "GET" && url.pathname === "/") {
				const port = (server.address() as any)?.port || 0;
				const html = generatePlanViewerHTML({ markdown, title, mode: purpose, port });
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
			});
		});
	});
}

function openBrowser(url: string): void {
	try {
		// macOS
		execSync(`open "${url}"`, { stdio: "ignore" });
	} catch {
		try {
			// Linux
			execSync(`xdg-open "${url}"`, { stdio: "ignore" });
		} catch {
			// Windows fallback
			try {
				execSync(`start "${url}"`, { stdio: "ignore" });
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
	grill: Type.Optional(Type.Boolean({ description: "Plan mode only: automatically arm a grill-me design interview for this plan (default true). The user's approval will direct you to interview first if no decisions were recorded." })),
});

// ── Extension ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let piRef = pi;

	// Track active servers so we can clean them up
	let activeServer: Server | null = null;
	let activeSession: { kind: ViewerPurpose; title: string; url: string; server: Server; onClose: () => void } | null = null;

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
		const { port, server, waitForResult } = await startViewerServer(markdown, title, purpose);
		activeServer = server;

		const url = `http://127.0.0.1:${port}`;
		activeSession = {
			kind: purpose,
			title: purpose === "questions" ? "Questions viewer" : "Plan viewer",
			url,
			server,
			onClose: () => {
				activeServer = null;
				activeSession = null;
			},
		};
		registerActiveViewer(activeSession);

		// Open the browser
		openBrowser(url);
		notifyViewerOpen(ctx, activeSession);

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
		} finally {
			// Clean up server after result
			cleanupServer();
		}
	}

	// ── Grill-me interview tools (built-in port of @firstpick/pi-extension-grill-me) ──

	pi.registerCommand("grill-me", {
		description: "Start a deterministic design interview and save results to Markdown",
		handler: async (args2: string, ctx2: ExtensionContext) => {
			const plan = args2.trim() || "(No plan supplied yet. Ask the user to paste or describe the plan first.)";
			const st = armGrillSession(ctx.cwd, plan);
			ctx.ui.notify(`Grill session initialized: ${grillStatePath(ctx.cwd)}`, "info");
			pi.sendUserMessage(
				`Start /grill-me for this plan:\n\n${plan}\n\nRules:\n- Interview me relentlessly about every aspect of this plan until we reach shared understanding.\n- Walk down each branch of the design tree, resolving dependencies between decisions one-by-one.\n- Ask exactly one question at a time.\n- For each question, provide your recommended answer.\n- If a question can be answered by exploring the codebase, explore the codebase instead.\n- Use grill_record_turn after each question/answer decision is captured.\n- For every resolved turn, include my explicit choice in userAnswer; do not leave the answer only in notes.\n- Use grill_save_results to save the results into a Markdown file in the project directory when enough understanding has been reached or when I ask to stop/save.`,
			);
			void st;
		},
	});

	pi.registerTool({
		name: "grill_record_turn",
		label: "Grill Record Turn",
		description: "Record one grill-me question, recommended answer, user answer, and decision status in project state (.pi/grill-me/state.json).",
		promptSnippet: "Record structured progress for an active grill-me design interview",
		promptGuidelines: [
			"Use grill_record_turn after each grill-me interview question is answered or resolved from codebase exploration.",
			"For a resolved turn, userAnswer must contain the explicit selected or discovered answer; notes are not a substitute.",
			"Do not use grill_record_turn for more than one question at a time.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "The exact question asked, one question only." }),
			recommendedAnswer: Type.String({ description: "The assistant's recommended answer to the question." }),
			userAnswer: Type.Optional(Type.String({ description: "The user's explicit answer. Required when decisionStatus is resolved." })),
			decisionStatus: Type.Union([
				Type.Literal("resolved"),
				Type.Literal("open"),
				Type.Literal("needs-codebase-check"),
			]),
			notes: Type.Optional(Type.String({ description: "Short rationale, dependency, or follow-up notes." })),
		}),
		async execute(_toolCallId: string, params: any, _signal: unknown, _onUpdate: unknown, ctx2: ExtensionContext) {
			const turn = params as GrillTurn;
			const res = recordGrillTurn(ctx.cwd, turn);
			if (!res.ok) {
				return {
					content: [{ type: "text" as const, text: res.error }],
					isError: true,
					details: { path: ".pi/grill-me/state.json" },
				};
			}
			return {
				content: [{ type: "text" as const, text: `Recorded grill turn #${res.count}` }],
				details: { count: res.count },
			};
		},
	});

	pi.registerTool({
		name: "grill_save_results",
		label: "Grill Save Results",
		description: "Save the active grill-me interview state as a Markdown file inside the project directory (default GRILL-ME.md).",
		promptSnippet: "Save grill-me interview decisions and risks to Markdown in the project directory",
		promptGuidelines: ["Use grill_save_results when the grill-me interview is complete or the user asks to save/stop."],
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Relative output path. Defaults to GRILL-ME.md." })),
			summary: Type.Optional(Type.String({ description: "Optional current shared-understanding summary." })),
			agreedDecisions: Type.Optional(Type.Array(Type.String())),
			openRisks: Type.Optional(Type.Array(Type.String())),
			nextDecisionNeeded: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId: string, params: any, _signal: unknown, _onUpdate: unknown, ctx2: ExtensionContext) {
			const p = params as { path?: string; summary?: string; agreedDecisions?: string[]; openRisks?: string[]; nextDecisionNeeded?: string };
			const res = saveGrillResults(ctx.cwd, {
				summary: p.summary,
				agreedDecisions: p.agreedDecisions,
				openRisks: p.openRisks,
				nextDecisionNeeded: p.nextDecisionNeeded,
			}, p.path);
			if ("error" in res && res.error) {
				return {
					content: [{ type: "text" as const, text: (res as any).error }],
					isError: true,
					details: {},
				};
			}
			const ok = res as { path: string; turns: number };
			return {
				content: [{ type: "text" as const, text: `Saved grill results to ${ok.path}` }],
				details: { path: ok.path, turns: ok.turns },
			};
		},
	});

	// ── show_plan tool ───────────────────────────────────────────────

	pi.registerTool({
		name: "show_plan",
		label: "Show Plan",
		description:
			"Open an interactive markdown viewer overlay. Two modes:\n\n" +
			"**Plan mode** (default): Renders a markdown plan for review. User can edit, " +
			"reorder, toggle checkboxes, and approve or decline. If approved, an approval " +
			"message is automatically sent to continue the conversation.\n\n" +
			"**Questions mode** (mode='questions'): Renders markdown containing follow-up " +
			"questions. User can navigate questions, type answers inline, and submit. " +
			"Questions are auto-detected (lines ending with '?' or containing 'Default:'). " +
			"Returns formatted answers.\n\n" +
			"The markdown file IS the UI — update it to change what the user sees.",
		parameters: ShowPlanParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { file_path, title, mode: modeStr } = params as {
				file_path: string;
				title?: string;
				mode?: string;
			};

			const purpose: ViewerPurpose = modeStr === "questions" ? "questions" : "plan";
			const grillEnabled = modeStr !== "questions" && params.grill !== false;

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

			// Auto-arm the design interview when showing a plan for approval.
			if (grillEnabled) {
				try {
					const st = armGrillSession(ctx.cwd, markdown, file_path);
					ctx.ui.notify(`🔥 Grill-me armed (${st.turns.length} prior turns) — approval will gate on interview depth`, "info");
				} catch {}
			}

			// Open viewer and wait for result
			const result = await runViewer(ctx, markdown, file_path, displayTitle, purpose, signal);

			// ── Questions mode result ────────────────────────────────
			if (purpose === "questions") {
				if (result.action === "approved") {
					const answerText = result.answers || "(no answers provided)";

					piRef.sendMessage(
						{
							customType: "plan-viewer-answers",
							content: `Here are my answers:\n\n${answerText}`,
							display: true,
						},
						{ deliverAs: "followUp" as any, triggerTurn: true },
					);

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
				const modifiedNote = result.modified
					? " (plan was edited by user — use the updated version)"
					: "";

				// Grill integration: direct what happens after approval based on
				// interview progress recorded via grill_record_turn.
				const grill = grillEnabled ? readGrillState(ctx.cwd) : undefined;
				const unresolved = grill?.turns.filter((t2) => t2.decisionStatus !== "resolved") ?? [];
				let approvalContent = `Plan approved! Proceed with implementation.${modifiedNote}`;
				if (grill) {
					if (grill.turns.length === 0) {
						approvalContent += `\n\n🔥 GRILL-ME INTERVIEW REQUIRED before implementation (auto-armed): interview the user about this plan — one question at a time, with your recommended answer each time; answer questions from the codebase when possible instead of asking. Record each decision with grill_record_turn and save the final write-up with grill_save_results. Cover every design branch that materially affects implementation, then start implementing without re-asking anything already resolved.`;
					} else if (unresolved.length > 0) {
						approvalContent += `\n\n🔥 Grill-me has ${unresolved.length} unresolved question(s): ` + unresolved.slice(0, 5).map((t2) => `"${t2.question}"`).join("; ") + `. Resolve these first (ask the user or check the codebase), record them with grill_record_turn, then proceed.`;
					} else {
						approvalContent += `\n\n✅ Grill-me interview complete (${grill.turns.length} decisions recorded — honor them exactly).`;
					}
				}
				piRef.sendMessage(
					{
						customType: "plan-approved",
						content: approvalContent,
						display: true,
					},
					{ deliverAs: "followUp" as any, triggerTurn: true },
				);

				return {
					content: [{
						type: "text" as const,
						text: (() => {
						let msg = `Plan approved by user.${modifiedNote} The updated plan has been saved to ${file_path}.`;
						if (grillEnabled && grill) {
							const unres = grill.turns.filter((t3) => t3.decisionStatus !== "resolved").length;
							if (grill.turns.length === 0) msg += " Grill-me armed but no questions asked yet — run the required design interview before implementing.";
							else if (unres > 0) msg += ` Grill-me has ${unres} unresolved question(s) to resolve first.`;
							else msg += ` Grill-me complete: ${grill.turns.length} decisions recorded.`;
						}
						return msg;
					})(),
					}],
					details: {
						action: "approved" as const,
						purpose: "plan",
						modified: result.modified,
						filePath: file_path,
						grillTurns: grill?.turns.length ?? 0,
						grillUnresolved: grill?.turns.filter((t3) => t3.decisionStatus !== "resolved").length ?? 0,
					},
				};
			}

			return {
				content: [{
					type: "text" as const,
					text: "User closed the plan viewer without approving. Ask if they want changes or have feedback.",
				}],
				details: {
					action: "declined" as const,
					purpose: "plan",
					modified: result.modified,
					filePath: file_path,
				},
			};
		},

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

			const result = await runViewer(ctx, markdown, filePath, displayTitle, "plan");

			if (result.action === "approved") {
				piRef.sendMessage(
					{
						customType: "plan-approved",
						content: `Plan approved! Proceed with implementation.${result.modified ? " (plan was edited)" : ""}`,
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
