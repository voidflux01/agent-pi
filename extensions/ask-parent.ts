// ABOUTME: ask_parent — blocking child->parent questions over filesystem mailboxes.
// ABOUTME: A sub-agent calls ask_parent; the question lands in
// ABOUTME: .pi/agent-sessions/asks/<id>.json and the tool polls until the
// ABOUTME: parent (or the user via /asks + /ask-answer) writes an answer or
// ABOUTME: the timeout expires. Transport-independent: works headless,
// ABOUTME: in-process, and in herdr panes alike.
// ABOUTME: Parent side provides visibility commands; nothing here blocks the parent.

import { existsSync, readFileSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { deliverMail, listMail, readMail, settleMail, sendSteer, mailboxRoot, type MailRecord } from "./lib/fleet-mailbox.ts";

const DEFAULT_TIMEOUT_S = Number(process.env.PI_ASK_PARENT_TIMEOUT_S || 600);
// Legacy flat dir kept readable so /asks still shows pre-migration questions.
const LEGACY_ASKS_DIR = join(process.cwd(), ".pi", "agent-sessions", "asks");

export interface AskRecord {
	id: string;
	agent: string;
	sessionFile?: string;
	question: string;
	options?: string[];
	status: "open" | "answered" | "expired" | "cancelled";
	answer?: string;
	createdAt: number;
	updatedAt: number;
}

export /** One mailbox per side: questions land in "parent"'s inbox; answers go to the child's. */
const PARENT = "parent";

function toMail(rec: AskRecord): MailRecord {
	return {
		schema: 1,
		id: rec.id,
		kind: "question",
		from: rec.agent,
		to: PARENT,
		expectsReply: true,
		subject: rec.question.slice(0, 80),
		body: rec.question,
		options: rec.options,
		status: rec.status,
		answer: rec.answer,
		createdAt: rec.createdAt,
		updatedAt: rec.updatedAt,
	};
}

function fromMail(m: MailRecord, sessionFile?: string): AskRecord {
	return {
		id: m.id,
		agent: m.from,
		sessionFile,
		question: m.body ?? "",
		options: m.options,
		status: m.status,
		answer: m.answer,
		createdAt: m.createdAt,
		updatedAt: m.updatedAt,
	};
}


function readAsk(id: string, cwd: string | undefined, agentHint?: string): AskRecord | null {
	const root = mailboxRoot(cwd ?? process.cwd());
	if (agentHint) {
		const m = readMail(root, agentHint, id);
		if (m) return fromMail(m);
	}
	// Parent-side lookup: scan every inbox for the id.
	const agentsDir = join(root, "agents");
	if (!existsSync(agentsDir)) return null;
	for (const dir of readdirSync(agentsDir)) {
		const m = readMail(root, dir, id);
		if (m && m.kind === "question") return fromMail(m);
	}
	return null;
}

function writeQuestion(rec: AskRecord, cwd?: string): void {
	deliverMail(mailboxRoot(cwd ?? process.cwd()), PARENT, toMail(rec));
}

function writeAnswerToChild(id: string, answer: string, cwd?: string): boolean {
	const root = mailboxRoot(cwd ?? process.cwd());
	const q = readAsk(id, cwd);
	if (!q || q.status !== "open") return false;
	const settled = settleMail(root, PARENT, id, (m) => ({ ...m, status: "answered", answer: answer.slice(0, 4000) }));
	if (!settled) return false;
	// Mirror the answered record into the asking child's inbox so a polling
	// child (possibly another runtime) sees the answer without scanning all boxes.
	try {
		settleMail(root, q.agent, id, (m) => ({ ...m, status: "answered", answer: settled.answer }));
	} catch {}
	return true;
}

export async function fileAskAndWait(
	question: string,
	opts: { agent: string; sessionFile?: string; options?: string[]; timeoutMs?: number; cwd?: string } ,
): Promise<{ answered: boolean; answer: string }> {
	const id = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
	const rec: AskRecord = {
		id,
		agent: opts.agent,
		sessionFile: opts.sessionFile,
		question: question.slice(0, 2000),
		options: opts.options?.slice(0, 6),
		status: "open",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
	writeQuestion(rec, opts.cwd);
	const deadline = Date.now() + Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_S * 1000, 30 * 60_000);
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 2000));
		const cur = readAsk(id, opts.cwd, opts.agent);
		if (!cur) break; // deleted => treat as cancel
		if (cur.status === "answered") return { answered: true, answer: cur.answer ?? "" };
		if (cur.status === "cancelled" || cur.status === "expired") return { answered: false, answer: "" };
	}
	for (let w = 0; w < 5; w++) {
		const cur = readAsk(id, opts.cwd, opts.agent);
		if (!cur || cur.status !== "open") break;
		try {
			settleMail(mailboxRoot(opts.cwd ?? process.cwd()), PARENT, id, (m) => ({ ...m, status: "expired" }));
		} catch {}
		await new Promise((r) => setTimeout(r, 200));
	}
	return { answered: false, answer: "" };
	return { answered: false, answer: "" };
}

/** Parent/user-side: answer an open ask by id. */
export function answerAsk(id: string, answer: string, cwd = process.cwd()): boolean {
	return writeAnswerToChild(id, answer, cwd);
}

export function listAsks(statusFilter?: AskRecord["status"], cwd = process.cwd()): AskRecord[] {
	const root = mailboxRoot(cwd ?? process.cwd());
	const out: AskRecord[] = [];
	try {
		const agentsDir = join(root, "agents");
		if (existsSync(agentsDir)) {
			for (const dir of readdirSync(agentsDir)) {
				for (const { rec: m } of listMail(root, dir, { includeAnswered: true })) {
					if (m.kind !== "question") continue;
					const r0 = fromMail(m);
					if (!statusFilter || r0.status === statusFilter) out.push(r0);
				}
			}
		}
		// Legacy flat-dir questions asked before the mailbox migration.
		if (existsSync(LEGACY_ASKS_DIR)) {
			for (const f of readdirSync(LEGACY_ASKS_DIR).sort()) {
				if (!f.endsWith(".json")) continue;
				try {
					const r1 = JSON.parse(readFileSync(join(LEGACY_ASKS_DIR, f), "utf8")) as AskRecord;
					if (!statusFilter || r1.status === statusFilter) out.push(r1);
				} catch {}
			}
		}
	} catch {}
	return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
}

export default function (pi: ExtensionAPI) {
	// Child-facing tool. The orchestrator passes our agent identity via env so
	// the record knows who is asking even inside --mode json runs.
	pi.registerTool({
		name: "ask_parent",
		description: `Ask the parent/captain a blocking question when genuinely stuck on a decision only they can make (scope changes, irreversible actions, missing credentials). Do NOT use it for discoverable answers - first inspect context and try a reversible default. The call BLOCKS until the parent answers or the timeout (${DEFAULT_TIMEOUT_S}s) elapses.`,
		parameters: Type.Object({
			question: Type.String({ description: "One precise question. Include what you tried and the default you would pick." }),
			options: Type.Optional(Type.Array(Type.String(), { description: "Up to 6 concrete options to choose from." })),
			timeout_s: Type.Optional(Type.Number({ description: "Max seconds to wait. Default from env; hard cap 1800." })),
		}),
		execute: async (_call: any, args: any) => {
			const res = await fileAskAndWait(String(args.question || ""), {
				agent: process.env.PI_AGENT_NAME || process.env.PI_SUBAGENT_NAME || "unknown",
				sessionFile: process.env.PI_SESSION_FILE,
				timeoutMs: (Number(args.timeout_s) > 0 ? Number(args.timeout_s) : DEFAULT_TIMEOUT_S) * 1000,
				options: Array.isArray(args.options) ? args.options.map(String) : undefined,
			});
			if (res.answered) {
				return { output: `PARENT ANSWERED:\n${res.answer}`, isError: false };
			}
			return { output: "No answer in time — proceed autonomously with your stated reversible default and note the open question in your ## RESULT under remaining.", isError: false };
		},
	});

	// ---- Parent-side visibility + answering -------------------------------
	pi.registerCommand("asks", {
		description: "List pending ask_parent questions from running sub-agents",
		handler: async (_args: string, ctx: any) => {
			const open = listAsks("open");
			if (open.length === 0) {
				ctx?.ui?.notify?.("No open asks.", "info");
				return;
			}
			for (const a of open.slice(0, 8)) {
				ctx?.ui?.notify?.(
					`[${a.id}] ${a.agent}${a.options?.length ? ` (options: ${a.options.join(" | ")})` : ""}\n${a.question}`,
					"warning",
				);
			}
			ctx?.ui?.notify?.(`Answer with: /ask-answer <id> <text>  (timeout: ${DEFAULT_TIMEOUT_S}s per ask)`, "info");
		},
	});

	pi.registerCommand("ask-answer", {
		description: "Answer a pending ask_parent question: /ask-answer <id> <text>",
		handler: async (args: string, ctx: any) => {
			const m = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
			if (!m) {
				ctx?.ui?.notify?.("usage: /ask-answer <id> <text>", "info");
				return;
			}
			const ok = answerAsk(m[1], m[2]);
			ctx?.ui?.notify?.(ok ? `Answered ${m[1]}.` : `No open ask ${m[1]} — check /asks`, ok ? "success" : "error");
		},
	});

	pi.registerCommand("nudge", {
		description: "Steer a running worker mid-task: /nudge <SA1|agent> <message>",
		handler: async (args: string, ctx: any) => {
			const m = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
			if (!m) {
				ctx?.ui?.notify?.("usage: /nudge <SA1|agent> <message>", "info");
				return;
			}
			// The widget displays SA<n>; translate that human-facing id to the
			// unique mailbox used by subagent-widget workers. Role names remain
			// supported for agent-team/chain/pipeline workers.
			const target = /^sa\d+$/i.test(m[1]) ? m[1].toLowerCase() : m[1];
			const rec = sendSteer(mailboxRoot(process.cwd()), target, m[2]);
			ctx?.ui?.notify?.(`Steer sent to ${rec.to} (${rec.id})`, "success");
		},
	});
}
