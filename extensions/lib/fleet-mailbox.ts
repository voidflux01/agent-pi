// ABOUTME: Runtime-neutral file mailbox for cross-agent questions/messages.
// ABOUTME: Maildir-style atomic delivery semantics (as popularized by AMQ), zero deps.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, statSync } from "fs";
import { dirname, join } from "path";

export type MailKind = "question" | "answer" | "decision" | "status";
export type MailStatus = "open" | "answered" | "expired" | "cancelled";

export interface MailRecord {
	schema: 1;
	id: string;
	kind: MailKind;
	from: string;              // agent name or "parent"
	to: string;                // agent name or "parent"
	thread?: string;           // thread/message id this replies to
	expectsReply?: boolean;
	subject?: string;
	body?: string;
	options?: string[];
	status: MailStatus;
	answer?: string;
	createdAt: number;
	updatedAt: number;
}

export function mailboxRoot(cwd = process.cwd()): string {
	return join(cwd, ".pi", "agent-sessions", "mailbox");
}

function inboxDir(root: string, agent: string): string {
	return join(root, "agents", agent.toLowerCase(), "inbox");
}

/** Atomic Maildir delivery: unique tmp write + fsync + no-replace style rename into new/. */
export function deliverMail(root: string, toAgent: string, rec: MailRecord): string {
	// NOTE: callers own updatedAt — mutating here would break redelivery
	// idempotency (same record must serialize byte-identically).
	const payload = JSON.stringify(rec, null, "\t") + "\n";
	const dir = inboxDir(root, toAgent);
	const tmp = join(dir, "tmp");
	const neu = join(dir, "new");
	mkdirSync(tmp, { recursive: true });
	mkdirSync(neu, { recursive: true });
	const name = `${rec.id}.json`;
	const tmpPath = join(tmp, `${name}.${process.pid}.${Date.now()}.tmp`);
	writeFileSync(tmpPath, payload);
	try {
		// best-effort durability without platform-specific fsync fcntl
		if ((globalThis as any).__fleetMailboxSync) {
			try { (globalThis as any).__fleetMailboxSync(tmpPath); } catch {}
		}
		if (!existsSync(join(neu, name))) {
			renameSync(tmpPath, join(neu, name));
			return join(neu, name);
		}
		// Idempotent collision: same id already delivered — drop the staged copy.
		const existing = readFileSync(join(neu, name));
		rmSync(tmpPath, { force: true });
		if (existing.equals(Buffer.from(payload))) return join(neu, name);
		throw new Error(`mailbox collision for ${name}`);
	} catch (e) {
		try { rmSync(tmpPath, { force: true }); } catch {}
		throw e;
	}
}

/** List mail waiting in new/ plus settled mail retained in cur/ for an agent. */
export function listMail(root: string, agent: string, opts: { includeAnswered?: boolean } = {}): Array<{ path: string; rec: MailRecord }> {
	const out: Array<{ path: string; rec: MailRecord }> = [];
	const base = inboxDir(root, agent);
	for (const sub of ["new", ...(opts.includeAnswered ? ["cur"] : [])]) {
		const d = join(base, sub);
		if (!existsSync(d)) continue;
		for (const f of readdirSync(d)) {
			if (!f.endsWith(".json")) continue;
			try {
				out.push({ path: join(d, f), rec: JSON.parse(readFileSync(join(d, f), "utf8")) as MailRecord });
			} catch {}
		}
	}
	return out.sort((a, b) => a.rec.createdAt - b.rec.createdAt);
}

/** Settle a message: atomic move from new/ into cur/ with updated record. */
export function settleMail(root: string, toAgent: string, id: string, mutate: (r: MailRecord) => MailRecord): MailRecord | null {
	const neu = join(inboxDir(root, toAgent), "new", `${id}.json`);
	const cur = join(inboxDir(root, toAgent), "cur", `${id}.json`);
	mkdirSync(dirname(cur), { recursive: true });
	let src = neu;
	if (!existsSync(neu)) {
		if (!existsSync(cur)) return null;
		src = cur;
	}
	const rec = mutate(JSON.parse(readFileSync(src, "utf8")) as MailRecord);
	rec.updatedAt = Date.now();
	const tmp = `${cur}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(rec, null, "\t") + "\n");
	renameSync(tmp, cur);
	if (src !== cur) rmSync(src, { force: true });
	return rec;
}

export function readMail(root: string, toAgent: string, id: string): MailRecord | null {
	for (const sub of ["new", "cur"]) {
		const p = join(inboxDir(root, toAgent), sub, `${id}.json`);
		if (existsSync(p)) {
			try { return JSON.parse(readFileSync(p, "utf8")) as MailRecord; } catch {}
		}
	}
	return null;
}
