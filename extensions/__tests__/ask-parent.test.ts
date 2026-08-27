import { describe, expect, test } from "bun:test";
import { fileAskAndWait, answerAsk, listAsks, type AskRecord } from "../ask-parent.ts";
import { deliverMail, settleMail, listMail, readMail, buildMailboxPreamble, mailboxPreambleEnabled } from "../lib/fleet-mailbox.ts";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("ask_parent mailbox", () => {
	test("open ask is visible via listAsks and answered by id", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "ask-parent-e2e-"));
		const waiter = fileAskAndWait("Which database should I pick?", {
			agent: "builder",
			options: ["postgres", "sqlite"],
			timeoutMs: 15_000,
			cwd,
		});
		// wait for the ask file to appear
		let rec: AskRecord | null = null;
		for (let i = 0; i < 100 && !rec; i++) {
			await new Promise((r) => setTimeout(r, 100));
			rec = listAsks("open", cwd)[0] ?? null;
		}
		expect(rec).not.toBeNull();
		expect(rec!.agent).toBe("builder");
		expect(rec!.question).toContain("database");

		expect(answerAsk(rec!.id, "use sqlite - it ships with node", cwd)).toBe(true);
		const res = await waiter;
		expect(res.answered).toBe(true);
		expect(res.answer).toContain("sqlite");
		expect(listAsks("open", cwd)).toHaveLength(0);
	}, 30_000);

	test("timeout expires the ask with answered=false", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "ask-parent-e2e-"));
		const res = await fileAskAndWait("nobody home", { agent: "scout", timeoutMs: 1500, cwd });
		expect(res.answered).toBe(false);
		const expired = listAsks("expired", cwd);
		expect(expired.length).toBe(1);
	}, 20_000);
});


describe("fleet-mailbox", () => {
	test("deliver is atomic + idempotent on same payload, collides on different payload", () => {
		const root = join(mkdtempSync(join(tmpdir(), "fmb-")), "root");
		const base = { schema: 1 as const, kind: "question" as const, from: "scout", to: "parent", expectsReply: true, status: "open" as const, createdAt: 1, updatedAt: 1 };
		const a = { ...base, id: "m1", body: "one" };
		expect(() => deliverMail(root, "parent", a)).not.toThrow();
		const path = deliverMail(root, "parent", { ...base, id: "m1", body: "one" });
		expect(existsSync(path)).toBe(true);
		expect(() => deliverMail(root, "parent", { ...base, id: "m1", body: "different" })).toThrow(/collision/);
	});

	test("settle moves new -> cur and readMail finds it in either", () => {
		const root = join(mkdtempSync(join(tmpdir(), "fmb-")), "root");
		deliverMail(root, "builder", { schema: 1, kind: "question", from: "scout", to: "parent", status: "open", createdAt: 2, updatedAt: 2, id: "m2", body: "q" });
		const settled = settleMail(root, "builder", "m2", (r) => ({ ...r, status: "answered", answer: "yes" }));
		expect(settled?.status).toBe("answered");
		expect(readMail(root, "builder", "m2")?.answer).toBe("yes");
	});

	test("listMail sorts by createdAt and filters cur by default", () => {
		const root = join(mkdtempSync(join(tmpdir(), "fmb-")), "root");
		deliverMail(root, "parent", { schema: 1, kind: "question", from: "a", to: "parent", status: "open", createdAt: 5, updatedAt: 5, id: "late", body: "" });
		deliverMail(root, "parent", { schema: 1, kind: "question", from: "a", to: "parent", status: "open", createdAt: 3, updatedAt: 3, id: "early", body: "" });
		settleMail(root, "parent", "early", (r) => ({ ...r, status: "answered" }));
		const openOnly = listMail(root, "parent").map((x) => x.rec.id);
		const withCur = listMail(root, "parent", { includeAnswered: true }).map((x) => x.rec.id);
		expect(openOnly).toEqual(["late"]);
		expect(withCur).toEqual(["early", "late"]);
	});
});


describe("mailbox protocol preamble", () => {
	test("builds worker instructions with exact inbox paths", () => {
		const cwd = mkdtempSync(join(tmpdir(), "fmb-pre-"));
		const p = buildMailboxPreamble("Omp-Agent", cwd);
		expect(p).toContain('worker "omp-agent"');
		expect(p).toContain("omp-agent/inbox");
		expect(p).toContain('"kind":"question"');
		expect(p).toContain('"to":"parent"');
	});

	test("env gate PI_FLEET_MAILBOX=0 disables preamble", () => {
		const prev = process.env.PI_FLEET_MAILBOX;
		process.env.PI_FLEET_MAILBOX = "0";
		try {
			expect(mailboxPreambleEnabled()).toBe(false);
		} finally {
			if (prev === undefined) delete process.env.PI_FLEET_MAILBOX;
			else process.env.PI_FLEET_MAILBOX = prev;
		}
		expect(mailboxPreambleEnabled()).toBe(true);
	});
});
