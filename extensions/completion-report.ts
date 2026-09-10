// ABOUTME: Completion Report Viewer — opens a GUI browser window showing work summary, file diffs, and rollback controls.
// ABOUTME: Gathers git diff data, renders interactive report with per-file rollback capability.

import type { AgentToolResult, ExtensionAPI, Theme, ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";
import { registerToolWithExecutor } from "./lib/tool-executor-registry.ts";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { outputLine, type OutputBoxTheme } from "./lib/output-box.ts";
import { applyExtensionDefaults } from "./lib/themeMap.ts";
import { generateCompletionReportHTML, type ReportData, type ChangedFile } from "./lib/completion-report-html.ts";
import { createCompletionReportStandaloneExport, saveStandaloneExport } from "./lib/viewer-standalone-export.ts";
import { upsertPersistedReport } from "./lib/report-index.ts";
import { registerActiveViewer, clearActiveViewer, notifyViewerOpen } from "./lib/viewer-session.ts";
import { authorizeLocalServerRequest, createLocalServerAuth, type LocalServerAuth } from "./lib/local-server-auth.ts";
import {
	coordinationState,
	setCoordinationMode,
	getExecutionContract,
	getVerifierReceipt,
	getEvalGate,
	verificationScope,
	getWorkflowRunLink,
} from "./lib/coordination-state.ts";
import { completeDecision } from "./lib/execution-gate.ts";
import type { VerifierReceipt } from "./lib/verifier-runtime.ts";
import { buildWorkspaceManifest } from "./lib/workspace-manifest.ts";
import { explicitDispatchHandler } from "./lib/dispatch-runtime.ts";
import { readBoundedRequestBody } from "./lib/request-body.ts";
import { bindTaskContract, isAutonomousCompletionEnabled } from "./lib/autonomous-policy.ts";
import { hasCompletionOverride } from "./lib/completion-override.ts";
import { runAutonomousCompletion, builderRepairDispatcher } from "./lib/autonomous-completion.ts";
import { markWorkflowRunComplete } from "./lib/workflow-run.ts";

// ── Types ────────────────────────────────────────────────────────────

interface ReportResult {
	action: "done" | "rollback" | "closed";
	rolledBackFiles: string[];
}

const MAX_COMPLETION_REQUEST_BODY_BYTES = 256 * 1024;

/**
 * Surface verifier risk to the report reviewer. Risk is not just an overall
 * non-PASS status or the explicit Warnings list — the verifier report carries
 * verdicts per section (quality/security can be WARN or FAIL while the overall
 * status stays PASS), severity-tagged review findings, per-requirement status,
 * and failed-test counts. Any of those surviving to completion is residual risk
 * the reviewer must see rather than an unqualified success. We mirror the
 * verifier's own materiality: review findings below MEDIUM and clean sections
 * are not treated as risk.
 */
export function verifierRiskSummary(receipt: VerifierReceipt | undefined): { status: string; risks: string[] } | undefined {
	const report = receipt?.verifier?.report;
	if (!report) return undefined;
	const risks: string[] = [];
	const seen = new Set<string>();
	const push = (value: string) => {
		const key = value.trim().toLowerCase();
		if (!key || seen.has(key)) return;
		seen.add(key);
		risks.push(value.trim());
	};
	const nonPass = (status?: string) => !!status && !/^pass$/i.test(status);
	const material = (severity?: string) => severity === "CRITICAL" || severity === "HIGH" || severity === "MEDIUM";
	const findings = (items?: string[]) => (items ?? []).filter((item) => !!item && !/^none$/i.test(item));

	// Explicitly named residual-risk channels.
	for (const blocker of report.hard_blockers ?? []) if (!/^none$/i.test(blocker)) push(`[blocker] ${blocker}`);
	for (const warning of report.warnings ?? []) if (!/^none$/i.test(warning)) push(warning);

	// Requirements the verifier could not clear.
	for (const req of report.requirements ?? []) {
		if (!nonPass(req.status)) continue;
		const detail = req.evidence?.trim() ? ` — ${req.evidence.trim()}` : "";
		push(`[requirement ${req.status}] ${req.requirement}${detail}`);
	}

	// Review findings the verifier itself treats as material (its re-audit narrows to MEDIUM+).
	for (const finding of report.review?.findings ?? []) {
		if (!material(finding.severity)) continue;
		const where = finding.location?.trim() ? ` @ ${finding.location.trim()}` : "";
		const title = finding.title?.trim() || finding.evidence?.trim() || finding.category || "review finding";
		push(`[${finding.severity}] ${title}${where}`);
	}

	// Sections whose own verdict is not clean (WARN/FAIL) plus their findings.
	const sections: Array<[string, string | undefined, string[] | undefined]> = [
		["quality", report.quality?.status, report.quality?.findings],
		["security", report.security?.status, report.security?.findings],
		["behavior", report.behavior?.status, report.behavior?.findings],
		["contract", report.contract?.status, report.contract?.findings],
	];
	for (const [name, status, list] of sections) {
		if (nonPass(status)) for (const item of findings(list)) push(`[${name}] ${item}`);
	}

	// Failed tests even when no finding line was emitted.
	if ((report.behavior?.tests?.failed ?? 0) > 0) {
		push(`[behavior] ${report.behavior!.tests!.failed} test(s) failed`);
	}

	if (risks.length === 0) {
		// Overall non-PASS with nothing else concrete still deserves a flag.
		if (nonPass(report.status)) push(`Verifier reported ${report.status}; completion proceeded via override or autonomous path.`);
		else return undefined;
	}
	return { status: report.status, risks };
}

function formatVerifierRisks(risks: { status: string; risks: string[] }): string {
	const lines = risks.risks.map((r) => `  - ${r}`);
	return `Verifier ${risks.status === "PASS" ? "warning(s)" : `status ${risks.status}`}:\n${lines.join("\n")}`;
}

function readRequestBody(req: IncomingMessage, res: ServerResponse, onBody: (body: string) => void): void {
	readBoundedRequestBody(req, res, onBody, MAX_COMPLETION_REQUEST_BODY_BYTES, { ok: false, error: "Request body too large" }, { ok: false, error: "Request body unreadable" });
}

// ── Git Helpers ──────────────────────────────────────────────────────

export function execGit(args: string[], cwd: string): string {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

function isGitRepo(cwd: string): boolean {
	return execGit(["rev-parse", "--is-inside-work-tree"], cwd) === "true";
}

/**
 * Auto-detect the best base ref to diff against.
 * Priority:
 * 1. Explicit base_ref parameter
 * 2. If there are staged/unstaged changes, diff against HEAD
 * 3. HEAD~1 (last commit)
 */
function resolveBaseRef(cwd: string, explicitRef?: string): string {
	if (explicitRef) return explicitRef;

	// Check if there are uncommitted changes (staged or unstaged)
	const status = execGit(["status", "--porcelain"], cwd);
	if (status.length > 0) {
		return "HEAD";
	}

	// Default to last commit
	return "HEAD~1";
}

/**
 * Parse `git diff --numstat` output into file stats.
 */
function parseNumstat(output: string): Array<{ path: string; additions: number; deletions: number }> {
	if (!output.trim()) return [];
	return output.split("\n").filter(Boolean).map((line) => {
		const [add, del, ...pathParts] = line.split("\t");
		const path = pathParts.join("\t"); // handle paths with tabs (renames show as old\tnew)
		return {
			path: path.replace(/.*=> /, "").replace(/[{}]/g, "").trim(),
			additions: add === "-" ? 0 : parseInt(add, 10),
			deletions: del === "-" ? 0 : parseInt(del, 10),
		};
	});
}

/**
 * Detect file status (added, modified, deleted, renamed).
 */
function getFileStatuses(cwd: string, baseRef: string): Map<string, { status: ChangedFile["status"]; oldPath?: string }> {
	const statusMap = new Map<string, { status: ChangedFile["status"]; oldPath?: string }>();

	// For uncommitted changes
	if (baseRef === "HEAD") {
		// Unstaged changes
		const unstaged = execGit(["diff", "--name-status"], cwd);
		for (const line of unstaged.split("\n").filter(Boolean)) {
			const [status, ...parts] = line.split("\t");
			const filePath = parts[parts.length - 1];
			if (status.startsWith("R")) {
				statusMap.set(filePath, { status: "renamed", oldPath: parts[0] });
			} else if (status === "A") {
				statusMap.set(filePath, { status: "added" });
			} else if (status === "D") {
				statusMap.set(filePath, { status: "deleted" });
			} else {
				statusMap.set(filePath, { status: "modified" });
			}
		}

		// Staged changes
		const staged = execGit(["diff", "--cached", "--name-status"], cwd);
		for (const line of staged.split("\n").filter(Boolean)) {
			const [status, ...parts] = line.split("\t");
			const filePath = parts[parts.length - 1];
			if (!statusMap.has(filePath)) {
				if (status.startsWith("R")) {
					statusMap.set(filePath, { status: "renamed", oldPath: parts[0] });
				} else if (status === "A") {
					statusMap.set(filePath, { status: "added" });
				} else if (status === "D") {
					statusMap.set(filePath, { status: "deleted" });
				} else {
					statusMap.set(filePath, { status: "modified" });
				}
			}
		}

		// Untracked files
		const untracked = execGit(["ls-files", "--others", "--exclude-standard"], cwd);
		for (const filePath of untracked.split("\n").filter(Boolean)) {
			if (!statusMap.has(filePath)) {
				statusMap.set(filePath, { status: "added" });
			}
		}
	} else {
		// Committed changes
		const output = execGit(["diff", "--name-status", "--end-of-options", baseRef], cwd);
		for (const line of output.split("\n").filter(Boolean)) {
			const [status, ...parts] = line.split("\t");
			const filePath = parts[parts.length - 1];
			if (status.startsWith("R")) {
				statusMap.set(filePath, { status: "renamed", oldPath: parts[0] });
			} else if (status === "A") {
				statusMap.set(filePath, { status: "added" });
			} else if (status === "D") {
				statusMap.set(filePath, { status: "deleted" });
			} else {
				statusMap.set(filePath, { status: "modified" });
			}
		}
	}

	return statusMap;
}

/**
 * Gather all data needed for the completion report.
 */
function shouldSuppressReportFile(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	return normalized.startsWith(".context/test-exports/") ||
		normalized.startsWith(".context/reports/");
}

function summarizeSuppressedFile(filePath: string): string {
	return [
		"@@ -0,0 +1,1 @@",
		`+Diff preview suppressed for generated or bulky artifact: ${filePath}`,
		"+Use copy/save/export or open the file directly if you need to inspect the full contents.",
	].join("\n");
}

function gatherReportData(cwd: string, title: string, summary: string, baseRef: string): ReportData {
	const resolvedRef = resolveBaseRef(cwd, baseRef);

	// Get diff stats
	let numstatOutput: string;
	if (resolvedRef === "HEAD") {
		// Combine staged + unstaged + untracked
		const unstaged = execGit(["diff", "--numstat"], cwd);
		const staged = execGit(["diff", "--cached", "--numstat"], cwd);
		numstatOutput = [unstaged, staged].filter(Boolean).join("\n");
	} else {
		numstatOutput = execGit(["diff", "--numstat", "--end-of-options", resolvedRef], cwd);
	}

	const stats = parseNumstat(numstatOutput);
	const statuses = getFileStatuses(cwd, resolvedRef);

	// Get per-file diffs
	const files: ChangedFile[] = [];

	for (const stat of stats) {
		const statusInfo = statuses.get(stat.path) || { status: "modified" as const };
		let diff: string;

		if (resolvedRef === "HEAD") {
			// Try unstaged first, then staged
			diff = execGit(["diff", "--", stat.path], cwd);
			if (!diff) {
				diff = execGit(["diff", "--cached", "--", stat.path], cwd);
			}
		} else {
			diff = execGit(["diff", "--end-of-options", resolvedRef, "--", stat.path], cwd);
		}

		files.push({
			path: stat.path,
			status: statusInfo.status,
			additions: stat.additions,
			deletions: stat.deletions,
			diff: shouldSuppressReportFile(stat.path) ? summarizeSuppressedFile(stat.path) : diff,
			oldPath: statusInfo.oldPath,
		});
	}

	// Also add untracked files if diffing against HEAD
	if (resolvedRef === "HEAD") {
		const untracked = execGit(["ls-files", "--others", "--exclude-standard"], cwd);
		for (const filePath of untracked.split("\n").filter(Boolean)) {
			if (!files.some((f) => f.path === filePath)) {
				if (shouldSuppressReportFile(filePath)) {
					files.push({
						path: filePath,
						status: "added",
						additions: 1,
						deletions: 0,
						diff: summarizeSuppressedFile(filePath),
					});
					continue;
				}

				// Read file content to show as "all added"
				let content = "";
				try {
					content = readFileSync(join(cwd, filePath), "utf-8");
				} catch {
					content = "(binary or unreadable file)";
				}
				const lines = content.split("\n");
				const diff = lines.map((l) => `+${l}`).join("\n");
				files.push({
					path: filePath,
					status: "added",
					additions: lines.length,
					deletions: 0,
					diff: `@@ -0,0 +1,${lines.length} @@\n${diff}`,
				});
			}
		}
	}

	// Sort: modified first, then added, then deleted, then renamed
	const statusOrder: Record<string, number> = { modified: 0, added: 1, deleted: 2, renamed: 3 };
	files.sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9));

	const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
	const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

	// Read task markdown if it exists
	let taskMarkdown: string | undefined;
	const todoPath = join(cwd, ".context", "todo.md");
	if (existsSync(todoPath)) {
		try {
			taskMarkdown = readFileSync(todoPath, "utf-8");
		} catch { }
	}

	return {
		title,
		summary,
		files,
		baseRef: resolvedRef,
		totalAdditions,
		totalDeletions,
		taskMarkdown,
	};
}

// ── HTTP Server ──────────────────────────────────────────────────────

function startReportServer(
	report: ReportData,
	cwd: string,
): Promise<{ port: number; server: Server; waitForResult: () => Promise<ReportResult>; auth: LocalServerAuth }> {
	return new Promise((resolveSetup) => {
		const auth = createLocalServerAuth();
		let resolveResult: (result: ReportResult) => void;
		let settled = false;
		const settle = (result: ReportResult) => {
			if (settled) return;
			settled = true;
			resolveResult!(result);
		};
		const resultPromise = new Promise<ReportResult>((res) => {
			resolveResult = res;
		});

		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			const url = new URL(req.url || "/", `http://localhost`);
			if (!authorizeLocalServerRequest(req, res, auth, url)) return;

			// Serve the main HTML page
			if (req.method === "GET" && url.pathname === "/") {
				const port = (server.address() as any)?.port || 0;
				const html = generateCompletionReportHTML({ report, port });
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

			// Handle rollback
			if (req.method === "POST" && url.pathname === "/rollback") {
				readRequestBody(req, res, (body) => {
					try {
						const data = JSON.parse(body);
						const files: string[] = Array.isArray(data.files)
							? data.files.filter((filePath: unknown): filePath is string => typeof filePath === "string")
							: [];
						const baseRef: string = typeof data.baseRef === "string" && data.baseRef.length > 0 ? data.baseRef : "HEAD";
						const allowedFiles = new Set(report.files.flatMap((file) => [file.path, ...(file.oldPath ? [file.oldPath] : [])]));
						const errors: string[] = [];

						for (const filePath of files) {
							try {
								if (!allowedFiles.has(filePath)) throw new Error("File is not part of this report");
								if (baseRef === "HEAD") {
									// For uncommitted changes, checkout from HEAD
									execFileSync("git", ["checkout", "HEAD", "--", filePath], { cwd, encoding: "utf-8" });
								} else {
									// For committed changes, checkout from the base ref
									execFileSync("git", ["checkout", "--end-of-options", baseRef, "--", filePath], { cwd, encoding: "utf-8" });
								}
							} catch (err: any) {
								errors.push(`${filePath}: ${err.message}`);
							}
						}

						if (errors.length > 0) {
							res.writeHead(200, { "Content-Type": "application/json" });
							res.end(JSON.stringify({ ok: false, error: errors.join("; ") }));
						} else {
							res.writeHead(200, { "Content-Type": "application/json" });
							res.end(JSON.stringify({ ok: true }));
						}
					} catch {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "Invalid JSON" }));
					}
				});
				return;
			}

			// Handle result (done)
			if (req.method === "POST" && url.pathname === "/result") {
				readRequestBody(req, res, (body) => {
					try {
						const data = JSON.parse(body);
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ ok: true }));
						settle({
							action: data.action || "done",
							rolledBackFiles: data.rolledBackFiles || [],
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
				readRequestBody(req, res, (body) => {
					try {
						const data = JSON.parse(body);
						const desktop = join(homedir(), "Desktop");
						if (!existsSync(desktop)) mkdirSync(desktop, { recursive: true });
						const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
						const fileName = `report-${ts}.md`;
						const filePath = join(desktop, fileName);
						writeFileSync(filePath, data.content, "utf-8");
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
				try {
					const html = createCompletionReportStandaloneExport(report);
					const saved = saveStandaloneExport({ filePrefix: "report-readonly", html });
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true, message: `Standalone export saved to ~/Desktop/${saved.fileName}` }));
				} catch (err: any) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: err.message }));
				}
				return;
			}

			// 404
			res.writeHead(404);
			res.end("Not found");
		});

		server.on("close", () => {
			settle({ action: "closed", rolledBackFiles: [] });
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
			} catch { }
		}
	}
}

// ── Tool Parameters ──────────────────────────────────────────────────

const ShowReportParams = Type.Object({
	title: Type.Optional(Type.String({ description: "Title for the report (default: 'Completion Report')" })),
	summary: Type.Optional(Type.String({ description: "Markdown summary of the work done" })),
	base_ref: Type.Optional(Type.String({ description: "Git ref to diff against (default: auto-detect — HEAD for uncommitted changes, HEAD~1 for committed)" })),
	task: Type.Optional(Type.String({ maxLength: 4_000, description: "The task completed by this report when no approved contract is already bound" })),
});

// ── Extension ────────────────────────────────────────────────────────

export default function(pi: ExtensionAPI) {
	let activeServer: Server | null = null;
	let activeSession: { kind: "report"; title: string; url: string; launchUrl?: string; server: Server; onClose: () => void } | null = null;

	// A completion report is passive review material. If nobody opens/acts on
	// the viewer (headless drive, remote pane, user ignores the URL), waiting
	// forever wedges the whole turn (dogfood D12). Bound the wait; on timeout
	// close the server and finish gracefully — the report is already persisted
	// and nothing is rolled back.
	const REPORT_WAIT_MS = Number(process.env.PI_REPORT_WAIT_MS) || 300_000;
	async function awaitReportResult(waitForResult: () => Promise<ReportResult>): Promise<{ timedOut: boolean; result?: ReportResult }> {
		let settled = false;
		const finish = (timedOut: boolean, result?: ReportResult) => {
			if (settled) return;
			settled = true;
			resolver({ timedOut, result });
		};
		let resolver!: (v: { timedOut: boolean; result?: ReportResult }) => void;
		const raced = new Promise<{ timedOut: boolean; result?: ReportResult }>((res) => { resolver = res; });
		waitForResult().then((r) => finish(false, r)).catch(() => finish(true));
		const timer = setTimeout(() => finish(true), REPORT_WAIT_MS);
		timer.unref?.();
		raced.finally(() => clearTimeout(timer));
		return raced;
	}


	function cleanupServer() {
		const server = activeServer;
		activeServer = null;
		if (server) {
			try { server.close(); } catch { }
		}
		if (activeSession) {
			clearActiveViewer(activeSession);
			activeSession = null;
		}
	}

	// ── show_report tool ─────────────────────────────────────────────

	registerToolWithExecutor(pi, {
		name: "show_report",
		label: "Show Report",
		description:
			"Open a completion report viewer in the browser. Shows a summary of work done, " +
			"files changed with unified diffs, and per-file rollback controls.\n\n" +
			"When a contract or task is supplied, show_report verifies and repairs before allowing completion; it never authorizes or deploys changes.\n\n" +
			"Automatically gathers git diff data from the working directory. " +
			"Includes task completion data from .context/todo.md if available.\n\n" +
			"The user can review diffs, rollback individual files or all changes, " +
			"copy the report, or save it to the desktop.",
		parameters: ShowReportParams,

		execute: explicitDispatchHandler("subagent-tool", async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const {
				title = "Completion Report",
				summary = "",
				base_ref,
				task,
			} = params as { title?: string; summary?: string; base_ref?: string; task?: string };

			const cwd = ctx.cwd || process.cwd();

			let contract = getExecutionContract();
			if (!contract && task?.trim()) contract = bindTaskContract(task, cwd).contract;
			if (!contract) {
				return { content: [{ type: "text" as const, text: "Completion report blocked: no acceptance contract or non-empty task was supplied. Do not output done:true; report done:false or continue fixing." }], details: { error: true, completionBlocked: true, reason: "no acceptance contract or task" } };
			}
			const scope = verificationScope(cwd, contract.fingerprint);
			const manifest = buildWorkspaceManifest(cwd, contract.fingerprint);
			const receipt = getVerifierReceipt(scope);
			const mode = coordinationState().mode;
			const workflowRunId = getWorkflowRunLink(cwd)?.runId;
			const surface = mode === "PLAN" ? "plan-show-report" : mode === "SPEC" ? "spec-show-report" : "agent-show-report";
			const gate = completeDecision({
				surface,
				contract,
				receipt,
				workspaceManifestHash: manifest.hash,
				evalGate: getEvalGate(scope),
				overrideActive: hasCompletionOverride(cwd, contract),
			});
			if (!gate.allowed && isAutonomousCompletionEnabled()) {
				const autonomous = await runAutonomousCompletion({
					contract, cwd, mode, runId: workflowRunId, risk: "low",
					dispatchRepair: builderRepairDispatcher(ctx),
				});
				if (autonomous.allowed) {
					// Continue to report viewer after autonomous verification passes.
				} else {
					const handoff = autonomous.iteration?.action === "REPLAN" ? ` Switch to ${autonomous.iteration.nextMode || "PLAN"}, obtain fresh approval, then resume.` : "";
					return { content: [{ type: "text" as const, text: `Completion report blocked: ${autonomous.reason || gate.reason}.${handoff} Do not output done:true; report done:false or continue fixing.` }], details: { error: true, completionBlocked: true, reason: autonomous.reason || gate.reason, iteration: autonomous.iteration, ...(autonomous.runId ? { runId: autonomous.runId } : {}), ...(autonomous.iteration?.action === "REPLAN" ? { nextMode: autonomous.iteration.nextMode, approvalInstruction: "Obtain fresh approval for replanned scope before resuming." } : {}) } };
				}
			} else if (!gate.allowed) return { content: [{ type: "text" as const, text: `Completion report blocked: ${gate.reason} Call verify_execution first. Do not output done:true; report done:false or continue fixing.` }], details: { error: true, completionBlocked: true, reason: gate.reason, ...(workflowRunId ? { runId: workflowRunId } : {}) } };

			// Check if we're in a git repo
			if (!isGitRepo(cwd)) {
				return {
					content: [{ type: "text" as const, text: "Completion report blocked: this workspace is not a Git repository, so file changes and rollback cannot be determined. Initialize Git or use show_file for review. Do not output done:true; report done:false or continue fixing." }],
					details: { error: true, completionBlocked: true, reason: "not a git repository" },
				};
			}

			// Gather report data
			const report = gatherReportData(cwd, title, summary, base_ref || "");

			// Surface verifier risk (non-PASS reached via override/autonomous, or
			// PASS-with-warnings) to the reviewer — never present an unqualified
			// success when the verifier flagged anything.
			const verifierRisks = verifierRiskSummary(getVerifierReceipt(scope));
			if (verifierRisks) report.verifier = verifierRisks;
			const riskText = verifierRisks ? `\n\nVerifier risk:\n${formatVerifierRisks(verifierRisks)}` : "";

			if (report.files.length === 0) {
				try { markWorkflowRunComplete(cwd, workflowRunId); } catch { }
				return {
					content: [{ type: "text" as const, text: "No file changes detected. Nothing to report." }],
				};
			}
			// Clean up any previous server
			cleanupServer();

			// Start server and open browser
			const { port, server, waitForResult, auth } = await startReportServer(report, cwd);
			activeServer = server;

			const url = `http://127.0.0.1:${port}`;
			const launchUrl = `${url}/?token=${encodeURIComponent(auth.token)}`;
			activeSession = {
				kind: "report",
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
			openBrowser(launchUrl);
			notifyViewerOpen(ctx, activeSession);

			// Wait for user to close the report (bounded: unattended viewers
			// must not wedge the turn — D12).
			try {
				const { timedOut, result } = await awaitReportResult(waitForResult);
				if (timedOut || !result) {
					return {
						content: [{ type: "text" as const, text: `Completion report left open for review (${REPORT_WAIT_MS / 1000}s) with no action; report persisted, no files rolled back. Reopen with /report if you want to roll back.${riskText}` }],
						details: { action: "timeout", rolledBackFiles: [], totalFiles: report.files.length, totalAdditions: report.totalAdditions, totalDeletions: report.totalDeletions, ...(workflowRunId ? { runId: workflowRunId } : {}) },
					};
				}

				try {
					upsertPersistedReport({
						category: "completion",
						title,
						summary,
						sourcePath: join(cwd, ".context", "todo.md"),
						viewerPath: join(cwd, ".context", "todo.md"),
						viewerLabel: title,
						tags: ["completion", "git", "diff"],
						metadata: {
							baseRef: report.baseRef,
							fileCount: report.files.length,
							totalAdditions: report.totalAdditions,
							totalDeletions: report.totalDeletions,
							action: result.action,
							rolledBackFiles: result.rolledBackFiles,
						},
					});
				} catch { }

				try { markWorkflowRunComplete(cwd, workflowRunId); } catch { }
				const rolledBack = result.rolledBackFiles.length;
				const closedSummary = (rolledBack > 0
					? `Report closed. ${rolledBack} file${rolledBack > 1 ? "s" : ""} rolled back: ${result.rolledBackFiles.join(", ")}`
					: "Report closed. No files were rolled back.") + riskText;

				// A completed show_report closes the workflow: return to the NORMAL
				// baseline so the next request is not left in an orchestration mode.
				// Only when no files were rolled back (rollback means the change was
				// not accepted and work continues). The mode-cycler's __piSetMode
				// also syncs the mode file and UI; fall back to the shared state.
				if (rolledBack === 0 && process.env.PI_SUBAGENT !== "1") {
					const currentMode = coordinationState().mode;
					if (currentMode !== "NORMAL") {
						try {
							const setMode = (globalThis as any).__piSetMode as undefined | ((mode: string, nextCtx?: any) => void);
							if (typeof setMode === "function") setMode("NORMAL", ctx);
							else setCoordinationMode("NORMAL");
						} catch { }
					}
				}

				return {
					content: [{ type: "text" as const, text: closedSummary }],
					details: {
						action: result.action,
						rolledBackFiles: result.rolledBackFiles,
						totalFiles: report.files.length,
						totalAdditions: report.totalAdditions,
						totalDeletions: report.totalDeletions,
						...(workflowRunId ? { runId: workflowRunId } : {}),
					},
				};
			} finally {
				cleanupServer();
			}
		}) as any,


		renderCall(args: Record<string, unknown>, theme: Theme) {
			const titleArg = (args as any).title || "Completion Report";
			const text =
				theme.fg("toolTitle", theme.bold("show_report ")) +
				theme.fg("success", titleArg);
			return new Text(outputLine(theme as unknown as OutputBoxTheme, "success", text), 0, 0);
		},

		renderResult(result: AgentToolResult<unknown>, _options: ToolRenderResultOptions, theme: Theme) {
			const details = ((result as any).details || result) as any;
			if (!details || (details.totalFiles === undefined && !details.content)) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			const fileCount = details.totalFiles ?? 0;
			const totalAdditions = details.totalAdditions ?? 0;
			const totalDeletions = details.totalDeletions ?? 0;
			const rolledBack = (details.rolledBackFiles || []).length;

			let info = `${fileCount} files · +${totalAdditions} -${totalDeletions}`;
			if (rolledBack > 0) {
				info += ` · ${rolledBack} rolled back`;
				return new Text(
					outputLine(theme as unknown as OutputBoxTheme, "warning", `Report closed — ${info}`),
					0, 0,
				);
			}

			return new Text(
				outputLine(theme as unknown as OutputBoxTheme, "success", `Report closed — ${info}`),
				0, 0,
			);
		},
	});

	// ── /report command ──────────────────────────────────────────────

	pi.registerCommand("report", {
		description: "Open the completion report viewer for current git changes",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/report requires interactive mode", "error");
				return;
			}

			const cwd = ctx.cwd || process.cwd();

			if (!isGitRepo(cwd)) {
				ctx.ui.notify("Not a git repository", "error");
				return;
			}

			// Parse optional base ref from args
			const baseRef = args.trim() || "";
			const report = gatherReportData(cwd, "Completion Report", "", baseRef);

			if (report.files.length === 0) {
				ctx.ui.notify("No file changes detected", "info");
				return;
			}

			cleanupServer();

			const { port, server, waitForResult, auth } = await startReportServer(report, cwd);
			activeServer = server;

			const url = `http://127.0.0.1:${port}`;
			const launchUrl = `${url}/?token=${encodeURIComponent(auth.token)}`;
			activeSession = {
				kind: "report",
				title: "Completion Report",
				url,
				launchUrl,
				server,
				onClose: () => {
					activeServer = null;
					activeSession = null;
				},
			};
			registerActiveViewer(activeSession);
			openBrowser(launchUrl);
			notifyViewerOpen(ctx, activeSession);

			const { timedOut, result } = await awaitReportResult(waitForResult);
			cleanupServer();
			if (timedOut || !result) {
				ctx.ui.notify("Completion report left open with no action (timeout); nothing rolled back.", "info");
				return;
			}

			if (result.rolledBackFiles.length > 0) {
				ctx.ui.notify(
					`Report closed — ${result.rolledBackFiles.length} file(s) rolled back`,
					"info",
				);
			} else {
				ctx.ui.notify("Report closed", "info");
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
	pi.on("session_before_switch", async () => {
		cleanupServer();
	});
}
