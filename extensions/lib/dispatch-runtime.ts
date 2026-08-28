// ABOUTME: Shared runtime for standard Pi subagent dispatches.
// ABOUTME: Owns headless/herdr transport selection, process lifecycle, and launch markers.

import { spawn, type ChildProcess } from "node:child_process";
import { childEnvironment } from "./child-runtime.ts";
import { authorizationMatchesActive, type DispatchAuthorization } from "./dispatch-gate.ts";
import {
	closeHerdrTabAsync,
	createHerdrTaskTabAsync,
	ensureHerdrWorkspaceAsync,
	herdrEnabledAsync,
	launchDonePath,
	pollDoneFileAsync,
	readLastAssistantText,
	cleanupLaunchFiles,
	registerHerdrPane,
	sendCommandToPaneAsync,
	shellQuote,
	updateHerdrPaneStatus,
	visiblePiTuiCommand,
	waitForLaunchStart,
	writeLaunchScript,
	type HerdrTabRef,
} from "./herdr-client.ts";
import { journalUpdate } from "./agent-task-journal.ts";

export {
	explicitDispatchHandler,
	withSessionLifecycle,
	currentDispatchAuthorization,
	isExplicitDispatchActive,
	type DispatchOrigin,
	type DispatchAuthorization,
} from "./dispatch-gate.ts";

export type DispatchTransport = "auto" | "headless" | "herdr";

export interface DispatchProcess {
	kill(signal?: NodeJS.Signals | number): void;
	/** Herdr handles do not emit child-process events. */
	once?(event: string, listener: (...args: any[]) => void): this;
	removeListener?(event: string, listener: (...args: any[]) => void): this;
	__piNoExitEvent?: boolean;
}

export interface DispatchRuntimeSpec {
	/** Required capability proving this call came from an explicit dispatch path. */
	authorization?: DispatchAuthorization;
	/** Full argv including the executable (e.g. `["pi", "--mode", "json", ..., task]`). */
	command: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	/** Directory used for Herdr launch markers. */
	launchDir: string;
	launchId: string;
	/** Session JSONL used as the authoritative result for a visible run. */
	sessionFile?: string;
	herdrDoneExtPath?: string;
	herdrLabel?: string;
	herdrPaneKey?: string;
	transport?: DispatchTransport;
	journal?: { dir: string; id: string };
	pollTimeoutMs?: number;
	herdrPollIntervalMs?: number;
	isAborted?: () => boolean;
	onProcess?: (process: DispatchProcess) => void;
	onStdoutLine?: (line: string) => void;
	onStderr?: (chunk: string) => void;
	onHerdrUpdate?: () => void;
	onTransport?: (transport: Exclude<DispatchTransport, "auto">) => void;
	/** Injected in tests; defaults to node's spawn. */
	spawnProcess?: typeof spawn;
}

export interface DispatchRuntimeResult {
	exitCode: number;
	stderr: string;
	/** Present when Herdr supplied the authoritative session text. */
	outputText?: string;
	transport: Exclude<DispatchTransport, "auto">;
}

const DEFAULT_POLL_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_HERDR_POLL_INTERVAL_MS = 3_000;

function updateJournal(spec: DispatchRuntimeSpec, patch: Record<string, unknown>): void {
	if (!spec.journal) return;
	journalUpdate(spec.journal.dir, spec.journal.id, patch);
}

function isAborted(spec: DispatchRuntimeSpec): boolean {
	try { return !!spec.isAborted?.(); } catch { return true; }
}

function processLike(child: ChildProcess): DispatchProcess {
	return child as unknown as DispatchProcess;
}

async function runHeadless(spec: DispatchRuntimeSpec): Promise<DispatchRuntimeResult> {
	const executable = spec.command[0];
	if (!executable) {
		return { exitCode: 1, stderr: "No child command supplied", transport: "headless" };
	}

	return new Promise((resolve) => {
		const spawnProcess = spec.spawnProcess || spawn;
		const child = spawnProcess(executable, spec.command.slice(1), {
			stdio: ["ignore", "pipe", "pipe"],
			env: spec.env || childEnvironment(),
			cwd: spec.cwd,
		});
		spec.onProcess?.(processLike(child));
		updateJournal(spec, { status: "running", pid: child.pid });

		let buffer = "";
		let stderr = "";
		const stdout = child.stdout;
		const childStderr = child.stderr;
		stdout?.setEncoding("utf-8");
		stdout?.on("data", (chunk: string) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (line.trim()) spec.onStdoutLine?.(line);
			}
		});
		childStderr?.setEncoding("utf-8");
		childStderr?.on("data", (chunk: string) => {
			stderr += chunk;
			spec.onStderr?.(chunk);
		});
		let settled = false;
		const finish = (exitCode: number) => {
			if (settled) return;
			settled = true;
			if (buffer.trim()) spec.onStdoutLine?.(buffer);
			updateJournal(spec, { status: exitCode === 0 ? "done" : "error", exitCode });
			resolve({ exitCode, stderr, transport: "headless" });
		};
		child.once("close", (code) => finish(code ?? 1));
		child.once("error", (error) => {
			const message = error instanceof Error ? error.message : String(error);
			stderr += message;
			spec.onStderr?.(message);
			finish(1);
		});
	});
}

async function runHerdr(spec: DispatchRuntimeSpec): Promise<DispatchRuntimeResult | null> {
	if (!spec.herdrDoneExtPath || !(await herdrEnabledAsync())) return null;
	if (isAborted(spec)) return { exitCode: 130, stderr: "Dispatch aborted", transport: "herdr" };

	let tab: HerdrTabRef | null = null;
	let ownedByHerdr = false;
	let aborted = false;
	let updateTimer: ReturnType<typeof setInterval> | undefined;
	let refs: ReturnType<typeof writeLaunchScript> | undefined;
	let terminalStatus: "done" | "error" = "error";
	const abort = () => {
		aborted = true;
		if (tab) void closeHerdrTabAsync(tab);
	};
	const paneProcess: DispatchProcess = {
		kill: abort,
		once: () => paneProcess,
		removeListener: () => paneProcess,
		__piNoExitEvent: true,
	};

	try {
		const workspaceId = process.env.HERDR_WORKSPACE_ID ||
			await ensureHerdrWorkspaceAsync("agent-pi", spec.cwd);
		if (!workspaceId) return null;

		refs = writeLaunchScript({
			dir: spec.launchDir,
			id: spec.launchId,
			cwd: spec.cwd,
			command: visiblePiTuiCommand(spec.command, spec.herdrDoneExtPath),
			env: {
				...(spec.env || childEnvironment()),
				HERDR_DONE_PATH: launchDonePath(spec.launchDir, spec.launchId),
			},
		});
		tab = await createHerdrTaskTabAsync(
			workspaceId,
			spec.cwd,
			spec.herdrLabel || `ap-${spec.launchId}`,
		);
		if (!tab) return null;

		spec.onProcess?.(paneProcess);
		updateJournal(spec, { status: "running" });
		const sent = await sendCommandToPaneAsync(tab.paneId, `bash ${shellQuote(refs.scriptPath)}`);
		if (!sent) {
			if (aborted || isAborted(spec)) return { exitCode: 130, stderr: "Dispatch aborted", transport: "herdr" };
			return null;
		}
		if (!(await waitForLaunchStart(refs.startedPath, 5_000, () => aborted || isAborted(spec)))) {
			if (aborted || isAborted(spec)) return { exitCode: 130, stderr: "Dispatch aborted", transport: "herdr" };
			return null;
		}

		ownedByHerdr = true;
		spec.onTransport?.("herdr");
		registerHerdrPane(spec.cwd, {
			key: spec.herdrPaneKey || spec.launchId,
			label: spec.herdrLabel || `ap-${spec.launchId}`,
			cwd: spec.cwd,
			sessionFile: spec.sessionFile,
			ref: tab,
			scriptPath: refs.scriptPath,
			donePath: refs.donePath,
			startedPath: refs.startedPath,
			status: "running",
		});
		updateTimer = setInterval(() => {
			if (!aborted && !isAborted(spec)) spec.onHerdrUpdate?.();
		}, spec.herdrPollIntervalMs ?? DEFAULT_HERDR_POLL_INTERVAL_MS);

		const exitCode = await pollDoneFileAsync(
			refs.donePath,
			spec.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
			() => aborted || isAborted(spec),
		);
		if (updateTimer) clearInterval(updateTimer);
		if (aborted || isAborted(spec)) {
			updateJournal(spec, { status: "error", exitCode: 130 });
			return { exitCode: 130, stderr: "Dispatch aborted", transport: "herdr" };
		}
		if (exitCode === null) {
			updateJournal(spec, { status: "error", exitCode: 1 });
			return { exitCode: 1, stderr: "Timed out waiting for Herdr output", transport: "herdr" };
		}
		const outputText = spec.sessionFile ? readLastAssistantText(spec.sessionFile).text : undefined;
		terminalStatus = exitCode === 0 ? "done" : "error";
		updateJournal(spec, { status: terminalStatus, exitCode });
		return { exitCode, stderr: "", outputText, transport: "herdr" };
	} catch (error) {
		if (updateTimer) clearInterval(updateTimer);
		if (ownedByHerdr) {
			updateJournal(spec, { status: "error", exitCode: 1 });
			return {
				exitCode: 1,
				stderr: error instanceof Error ? error.message : String(error),
				transport: "herdr",
			};
		}
		return null;
	} finally {
		if (updateTimer) clearInterval(updateTimer);
		if (refs) cleanupLaunchFiles(refs);
		if (tab) {
			updateHerdrPaneStatus(spec.cwd, spec.herdrPaneKey || spec.launchId, terminalStatus, tab);
			await closeHerdrTabAsync(tab);
		}
	}
}

/**
 * Run one standard Pi child. Herdr is attempted only in auto/herdr mode and
 * falls back to headless until the visible pane has acknowledged the launch.
 * A pane that has taken ownership is never duplicated by a second child.
 */
export async function run(spec: DispatchRuntimeSpec): Promise<DispatchRuntimeResult> {
	if (!authorizationMatchesActive(spec.authorization)) {
		const message = "Dispatch refused: an explicit tool or command authorization is required";
		updateJournal(spec, { status: "error", exitCode: 126, note: message });
		spec.onStderr?.(message);
		return { exitCode: 126, stderr: message, transport: "headless" };
	}

	const transport = spec.transport ?? "auto";
	if (transport !== "headless") {
		const herdrResult = await runHerdr(spec);
		if (herdrResult) return herdrResult;
	}
	const result = await runHeadless(spec);
	spec.onTransport?.("headless");
	return result;
}
