// ABOUTME: herdr-done — signals task completion to the parent's herdr
// ABOUTME: transport when pi workers run in interactive TUI mode inside a
// ABOUTME: visible pane. The headless `-p` path exits on its own; a TUI
// ABOUTME: worker stays alive waiting for input, so the first turn end is
// ABOUTME: the natural "job done" boundary. Writes $HERDR_DONE_PATH with
// ABOUTME: the (trivially successful) exit code; the process-exit done-file
// ABOUTME: from writeLaunchScript remains as the fallback signal.
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { writeFileSync } from "node:fs";

export default function (pi: ExtensionAPI) {
	let fired = false;
	pi.on("agent_end", async (_event: unknown) => {
		if (fired) return;
		fired = true;
		const p = process.env.HERDR_DONE_PATH;
		if (!p) return;
		try { writeFileSync(p, "0\n", "utf8"); } catch {}
	});
}
