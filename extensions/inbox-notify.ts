// ABOUTME: inbox-notify — parent-side arrival notifications for the fleet
// ABOUTME: mailbox. Watches agents/*/inbox/{new,cur} with fs.watch (falling
// BACKME: back to a 5s sweep when watchers are unavailable) and surfaces new
// ABOUTME: questions/steer deliveries via ui.notify so the captain does not
// ABOUTME: have to poll /asks. Files are written by ANY runtime — watch is on
// ABOUTME: the filesystem, so this stays runtime-neutral by construction.
import { existsSync, readdirSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { listMail, mailboxRoot } from "./lib/fleet-mailbox.ts";

export default function (pi: ExtensionAPI) {
	let watching = false;
	const seen = new Set<string>();

	function sweepOnce(ctx: any): void {
		const root = mailboxRoot(ctx?.cwd ?? process.cwd());
		const agentsDir = join(root, "agents");
		if (!existsSync(agentsDir)) return;
		try {
			for (const agent of readdirSync(agentsDir)) {
				for (const { path, rec } of listMail(root, agent)) {
					if (seen.has(path)) continue;
					seen.add(path);
					if (agent === "parent" && rec.kind === "question" && rec.status === "open") {
						ctx?.ui?.notify?.(`📬 New question from ${rec.from}: ${rec.subject ?? rec.body?.slice(0, 60) ?? rec.id} — /asks`, "info");
					} else if (rec.kind === "steer" && !rec.acknowledgedAt) {
						ctx?.ui?.notify?.(`↪️ Steer pending to ${rec.to}: ${rec.subject ?? ""}`, "info");
					}
				}
			}
			// prune entries whose files vanished (consumed/expired)
			for (const p of [...seen]) if (!existsSync(p)) seen.delete(p);
		} catch {}
	}

	pi.on("session_start", async (_event: unknown, ctx: any) => {
		if (watching) return;
		watching = true;
		const root = mailboxRoot(ctx?.cwd ?? process.cwd());
		const agentsDir = join(root, "agents");
		sweepOnce(ctx);
		const startWatcher = (dir: string): boolean => {
			try {
				watch(dir, () => sweepOnce(ctx));
				return true;
			} catch {
				return false;
			}
		};
		if (existsSync(agentsDir)) {
			startWatcher(agentsDir); // recursive watches vary by platform; also per-inbox:
			try {
				for (const agent of readdirSync(agentsDir)) {
					const inb = join(agentsDir, agent, "inbox");
					if (existsSync(inb)) {
						startWatcher(join(inb, "new"));
						startWatcher(join(inb, "cur"));
					}
				}
			} catch {}
		}
		// Low-frequency safety sweep so late-created inboxes are covered too.
		setInterval(() => sweepOnce(ctx), 15_000).unref?.();
	});
}
