// ABOUTME: Runtime-neutral file mailbox for cross-agent questions/messages.
// ABOUTME: Maildir-style atomic delivery semantics (as popularized by AMQ), zero deps.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, statSync } from "fs";
import { dirname, join } from "path";

export type MailKind = "question" | "answer" | "decision" | "status" | "steer";
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
	acknowledgedAt?: number;   // worker confirmed receipt (AMQ-style receipt)
	createdAt: number;
	updatedAt: number;
}

const PARENT_INBOX = "parent";
const DEFAULT_POLL_HINT_S = 300;
const SAFE_MAILBOX_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function mailboxName(value: string): string {
	const normalized = String(value || "").toLowerCase();
	if (!SAFE_MAILBOX_NAME.test(normalized)) throw new Error("Invalid mailbox agent or message id");
	return normalized;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function mailboxRoot(cwd = process.cwd()): string {
	return join(cwd, ".pi", "agent-sessions", "mailbox");
}

function inboxDir(root: string, agent: string): string {
	return join(root, "agents", mailboxName(agent), "inbox");
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
	const name = `${mailboxName(rec.id)}.json`;
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
	return out.sort((a, b) => (a.rec.createdAt - b.rec.createdAt) || (a.rec.id < b.rec.id ? -1 : a.rec.id > b.rec.id ? 1 : 0));
}

/** Settle a message: atomic move from new/ into cur/ with updated record. */
export function settleMail(root: string, toAgent: string, id: string, mutate: (r: MailRecord) => MailRecord): MailRecord | null {
	const safeId = mailboxName(id);
	const neu = join(inboxDir(root, toAgent), "new", `${safeId}.json`);
	const cur = join(inboxDir(root, toAgent), "cur", `${safeId}.json`);
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
		const p = join(inboxDir(root, toAgent), sub, `${mailboxName(id)}.json`);
		if (existsSync(p)) {
			try { return JSON.parse(readFileSync(p, "utf8")) as MailRecord; } catch {}
		}
	}
	return null;
}
export const MAILBOX_PROTOCOL_VERSION = 2;

/** Runtime-neutral env gate: PI_FLEET_MAILBOX=0 disables external participation. */
export function mailboxPreambleEnabled(): boolean {
	return process.env.PI_FLEET_MAILBOX !== "0";
}

/**
 * Compact instructions prepended to an EXTERNAL-CLI worker's task so its
 * model can file a blocking question into the shared mailbox using only
 * shell tools. Keep it small: these workers bill real tokens.
 */
export function buildMailboxPreamble(agentName: string, cwd: string): string {
	const agent = mailboxName(agentName);
	const root = mailboxRoot(cwd);
	const inbox = join(root, "agents", PARENT_INBOX, "inbox");
	const workerInbox = join(root, "agents", agent, "inbox");
	const workerNew = join(workerInbox, "new");
	const workerCur = join(workerInbox, "cur");
	const workerTmp = join(workerInbox, "tmp");
	const parentNew = join(inbox, "new");
	const parentTmp = join(inbox, "tmp");
	return [
		"[MAILBOX PROTOCOL v" + MAILBOX_PROTOCOL_VERSION + "]",
		`You are worker "${agent}". If — and only if — you are genuinely blocked on a decision only your captain can make (scope change, irreversible action, missing credential), you MAY ask one blocking question instead of guessing:`,
		`1. mkdir -p ${shellQuote(workerCur)} ${shellQuote(parentNew)} ${shellQuote(workerNew)} ${shellQuote(workerTmp)} ${shellQuote(parentTmp)}`,
		'2. Write ONE json file (atomic: write to tmp then rename into new/) named ask-<epoch36>-<rand>.json:',
		'   {"schema":1,"id":"ask-...","kind":"question","from":"' + agent + '","to":"parent","expectsReply":true,"subject":"<80 chars>","body":"<what you tried + your proposed default>","status":"open","createdAt":<ms>,"updatedAt":<ms>}',
		`3. Poll ${shellQuote(parentNew)} and ${shellQuote(join(inbox, "cur"))} every ~5s (up to ${DEFAULT_POLL_HINT_S}s total) for a file with the same id. When found and status=="answered", read .answer and proceed; delete nothing.`,
		"If no answer in time, proceed with your stated reversible default and note the open question at the end of your result.",
		`4. STEER CHANNEL: every ~10 tool actions (and always before finalizing), list ${shellQuote(workerNew)}; for each steer-*.json: read .body, incorporate it into your remaining work, acknowledge by rewriting the file with acknowledgedAt=<ms> added, then DELETE the file once fully handled. Steer messages come from your captain mid-task — treat them as high-priority course corrections.`,
		"Do not use the mailbox for anything besides asking, answering, and steer handling. End of protocol.",
	].join("\n");
}


// ── Steer channel (runtime-neutral fast lane) ──────────────────────────────
// Parent writes a steer mail into the WORKER's inbox/new/. Workers either:
//  - pi-family: nudge-listener extension auto-delivers via sendUserMessage
//    ({ deliverAs: "steer" }) and acknowledges, or
//  - external CLIs: taught by MAILBOX PREAMBLE v2 to check inbox between
//    actions, incorporate .body, then delete the file (= implicit consume).

/** Deliver an out-of-band steering instruction to a running worker. */
export function sendSteer(root: string, toAgent: string, message: string, from = PARENT_INBOX): MailRecord {
	const rec: MailRecord = {
		schema: 1,
		id: `steer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
		kind: "steer",
		from,
		to: toAgent.toLowerCase(),
		subject: message.slice(0, 80),
		body: message.slice(0, 2000),
		status: "open",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
	deliverMail(root, toAgent, rec);
	return rec;
}

/** Pending steer mails for an agent (oldest first). */
export function listSteer(root: string, agent: string): Array<{ path: string; rec: MailRecord }> {
	return listMail(root, agent).filter(({ rec }) => rec.kind === "steer");
}

/** Acknowledge one steer mail WITHOUT consuming it: sets acknowledgedAt in place. */
export function ackSteer(root: string, path: string): boolean {
	try {
		const raw = readFileSync(path, "utf8");
		const rec = JSON.parse(raw) as MailRecord;
		if (!rec.acknowledgedAt) {
			rec.acknowledgedAt = Date.now();
			rec.updatedAt = rec.acknowledgedAt;
			writeFileSync(path + ".tmp", JSON.stringify(rec, null, "\t") + "\n");
			renameSync(path + ".tmp", path); // same-dir rename is atomic; id unchanged so no collision
		}
		return true;
	} catch {
		return false;
	}
}

/** Consume (delete) one steer mail after incorporating it. Returns the record or null. */
export function consumeSteer(root: string, path: string): MailRecord | null {
	try {
		const rec = JSON.parse(readFileSync(path, "utf8")) as MailRecord;
		rmSync(path, { force: true });
		return rec;
	} catch {
		return null;
	}
}
