// ABOUTME: ask_parent — blocking child->parent questions over filesystem mailboxes.
// ABOUTME: A sub-agent calls ask_parent; the question lands in
// ABOUTME: .pi/agent-sessions/asks/<id>.json and the tool polls until the
// ABOUTME: parent (or the user via /asks + /ask-answer) writes an answer or
// ABOUTME: the timeout expires. Transport-independent: works headless,
// ABOUTME: in-process, and in herdr panes alike.
// ABOUTME: Parent side provides visibility commands; nothing here blocks the parent.

import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const ASKS_DIR = join(process.cwd(), ".pi", "agent-sessions", "asks");
const DEFAULT_TIMEOUT_S = Number(process.env.PI_ASK_PARENT_TIMEOUT_S || 600);

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

export function asksDir(cwd = process.cwd()): string {
	return join(cwd, ".pi", "agent-sessions", "asks");
}

function askPath(id: string, cwd = process.cwd()): string {
	return join(asksDir(cwd), `${id}.json`);
}

function readAsk(id: string, cwd = process.cwd()): AskRecord | null {
	try {
		return JSON.parse(readFileSync(askPath(id, cwd), "utf8")) as AskRecord;
	} catch {
		return null;
	}
}

function writeAsk(rec: AskRecord, cwd = process.cwd()): void {
	const p = askPath(rec.id, cwd);
	const payload = JSON.stringify(rec, null, "\t") + "\n";
	for (let attempt = 0; attempt < 10; attempt++) {
		mkdirSync(dirname(p), { recursive: true });
		try {
			writeFileSync(p, payload);
			if (readFileSync(p, "utf8") === payload) return;
		} catch {}
		// A worker whose module registry was previously poisoned by a node:fs
		// mock, or transient fs pressure, can leave early writes no-op'd; a
		// short verified retry keeps ask_parent reliable for real sub-agents.
		await0(20 * (attempt + 1));
	}
	throw new Error(`writeAsk could not persist ${p}`);
}function await0(ms: number): void {
	const until = Date.now() + ms;
	while (Date.now() < until) {}
}

/** Child-side API: file a blocking question, then wait for an answer. */
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
	writeAsk(rec, opts.cwd);
	const deadline = Date.now() + Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_S * 1000, 30 * 60_000);
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 2000));
		const cur = readAsk(id, opts.cwd);
		if (!cur) break; // deleted => treat as cancel
		if (cur.status === "answered") return { answered: true, answer: cur.answer ?? "" };
		if (cur.status === "cancelled" || cur.status === "expired") return { answered: false, answer: "" };
	}
	for (let w = 0; w < 5; w++) {
		const cur = readAsk(id, opts.cwd);
		if (!cur || cur.status !== "open") break;
		cur.status = "expired";
		cur.updatedAt = Date.now();
		writeAsk(cur, opts.cwd);
		await new Promise((r) => setTimeout(r, 200));
	}
	return { answered: false, answer: "" };
}

/** Parent/user-side: answer an open ask by id. */
export function answerAsk(id: string, answer: string, cwd = process.cwd()): boolean {
	const rec = readAsk(id, cwd);
	if (!rec || rec.status !== "open") return false;
	rec.status = "answered";
	rec.answer = answer.slice(0, 4000);
	rec.updatedAt = Date.now();
	writeAsk(rec, cwd);
	return true;
}

export function listAsks(statusFilter?: AskRecord["status"], cwd = process.cwd()): AskRecord[] {
	const dir = asksDir(cwd);
	if (!existsSync(dir)) return [];
	const out: AskRecord[] = [];
	try {
		for (const f of readdirSorted(dir)) {
			const rec = readAsk(f.replace(/\.json$/, ""), cwd);
			if (rec && (!statusFilter || rec.status === statusFilter)) out.push(rec);
		}
	} catch {}
	return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
}

function readdirSorted(dir: string): string[] {
	try {
		return require("node:fs").readdirSync(dir).filter((f: string) => f.endsWith(".json")).sort();
	} catch {
		return [];
	}
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
}
