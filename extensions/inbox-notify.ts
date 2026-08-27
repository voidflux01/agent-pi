// ABOUTME: inbox-notify — parent-side arrival notifications for the fleet
// ABOUTME: mailbox. Watches agents/*/inbox/{new,cur} with fs.watch plus a
// ABOUTME: safety sweep, surfacing new captain-facing asks and pending steers
// ABOUTME: via ui.notify so the operator never has to poll /asks. Files are
// ABOUTME: written by ANY runtime; watching the filesystem stays runtime-
// ABOUTME: neutral by construction.
// NOTE: never hold a live ctx across events — store cwd as a string at
// session_start and touch nothing else on ctx afterwards. A captured ctx
// throws "extension ctx is stale" once the session is replaced/reloaded,
// and an uncaught throw inside a timer KILLS the whole pi process.
import { existsSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { listMail, mailboxRoot } from "./lib/fleet-mailbox.ts";

export default function (pi: ExtensionAPI) {
	let armed = false;
	let baseCwd = "";
	const seen = new Set<string>();
	const watchers: FSWatcher[] = [];
	let sweepTimer: ReturnType<typeof setInterval> | undefined;

	function sweepOnce(notify?: (msg: string, level?: string) => void): void {
		if (!baseCwd) return;
		try {
			const root = mailboxRoot(baseCwd);
			const agentsDir = join(root, "agents");
			if (!existsSync(agentsDir)) return;
			for (const agent of readdirSync(agentsDir)) {
				for (const { path, rec } of listMail(root, agent)) {
					if (seen.has(path)) continue;
					seen.add(path);
					if (agent === "parent" && rec.kind === "question" && rec.status === "open") {
						notify?.(`📬 New question from ${rec.from}: ${rec.subject ?? rec.body?.slice(0, 60) ?? rec.id} — /asks`);
					} else if (rec.kind === "steer" && !rec.acknowledgedAt && rec.status === "open") {
						notify?.(`↪️ Steer pending to ${rec.to}: ${rec.subject ?? ""}`);
					}
				}
			}
			for (const p of [...seen]) if (!existsSync(p)) seen.delete(p);
		} catch {}
	}

	pi.on("session_start", async (_event: unknown, ctx: any) => {
		if (armed) return;
		armed = true;
		baseCwd = ctx?.cwd ?? process.cwd();
		const notify = (msg: string, level?: string) => {
			try { ctx?.ui?.notify?.(msg, level ?? "info"); } catch {}
		};
		sweepOnce(notify);
		const agentsDir = join(mailboxRoot(baseCwd), "agents");
		if (existsSync(agentsDir)) {
			const addWatch = (dir: string): void => {
				try { watchers.push(watch(dir, () => sweepOnce(notify))); } catch {}
			};
			addWatch(agentsDir);
			try {
				for (const agent of readdirSync(agentsDir)) {
					const inb = join(agentsDir, agent, "inbox");
					if (existsSync(inb)) {
						addWatch(join(inb, "new"));
						addWatch(join(inb, "cur"));
					}
				}
			} catch {}
		}
		sweepTimer = setInterval(() => sweepOnce(), 15_000);
		sweepTimer.unref?.();
	});

	pi.on("session_shutdown", async () => {
		for (const w of watchers.splice(0)) { try { w.close(); } catch {} }
		if (sweepTimer) clearInterval(sweepTimer);
		armed = false;
	});
}
