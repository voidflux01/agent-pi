// ABOUTME: Runtime artifact cleanup lifecycle: retention sweep at session start,
// ABOUTME: provably-dead artifacts at session shutdown. See lib/runtime-cleanup.ts.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { cleanupRuntimeArtifacts, cleanupSessionScrap, cleanupTerminalRuns, cleanupVerifierTranscripts } from "./lib/runtime-cleanup.ts";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		// Worker processes never clean: a subagent's ledger may still be needed by
		// the parent (resume/recovery), so cleanup only happens at the parent
		// session's own start/shutdown.
		if (process.env.PI_SUBAGENT === "1") return;
		// 7-day rolling retention over the artifact table, throttled to once per
		// 12h so a frequently-touched workspace is not re-walked every session.
		try { cleanupRuntimeArtifacts(ctx?.cwd || process.cwd()); } catch { }
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (process.env.PI_SUBAGENT === "1") return;
		const cwd = ctx?.cwd || process.cwd();
		// security-audit.log rotates itself by size (security-guard); untouched here.
		// Pure capture artifacts — no recovery or audit value, gone with the session.
		try { cleanupSessionScrap(cwd); } catch { }
		// Verifier transcripts are dead weight once their receipt is persisted.
		try { cleanupVerifierTranscripts(cwd); } catch { }
		// Terminal orchestration runs (no active.json) are done; their event
		// ledger is not needed for recovery.
		try { cleanupTerminalRuns(cwd); } catch { }
	});
}