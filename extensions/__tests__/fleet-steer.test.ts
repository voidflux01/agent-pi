import { describe, expect, it } from "bun:test";
import { mkdirSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildMailboxPreamble,
	ackSteer,
	consumeSteer,
	listSteer,
	mailboxRoot,
	sendSteer,
} from "../lib/fleet-mailbox.ts";

function mk(): string {
	const dir = join(tmpdir(), `steer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("steer channel", () => {
	it("sends a steer mail into the worker inbox", () => {
		const cwd = mk();
		const rec = sendSteer(mailboxRoot(cwd), "omp-agent", "prefer x over y");
		expect(rec.kind).toBe("steer");
		expect(rec.to).toBe("omp-agent");
		expect(existsSync(rec ? join(mailboxRoot(cwd), "agents", "omp-agent", "inbox", "new", rec.id + ".json") : "/nope")).toBe(true);
	});

	it("lists pending steer mails oldest-first and acks in place", () => {
		const cwd = mk();
		sendSteer(mailboxRoot(cwd), "builder", "one");
		sendSteer(mailboxRoot(cwd), "builder", "two");
		const bodies = () => listSteer(mailboxRoot(cwd), "builder").map(x => x.rec.body).sort();
		let items = listSteer(mailboxRoot(cwd), "builder");
		expect(items.length).toBe(2);
		expect(bodies()).toEqual(["one", "two"]);
		const firstAcked = items.find(x => x.rec.body === "one")!;
		expect(firstAcked.rec.acknowledgedAt).toBeUndefined();
		expect(ackSteer(mailboxRoot(cwd), firstAcked.path)).toBe(true);
		items = listSteer(mailboxRoot(cwd), "builder");
		const one = items.find(x => x.rec.body === "one")!;
		expect(one.rec.acknowledgedAt).toBeGreaterThan(0);
		// idempotent second ack does not clobber
		const t0 = one.rec.acknowledgedAt;
		ackSteer(mailboxRoot(cwd), one.path);
		expect(listSteer(mailboxRoot(cwd), "builder").find(x => x.rec.body === "one")!.rec.acknowledgedAt).toBe(t0);
	});

	it("consumes a steer mail (file removed)", () => {
		const cwd = mk();
		sendSteer(mailboxRoot(cwd), "scout", "shift focus to tests");
		const [{ path }] = listSteer(mailboxRoot(cwd), "scout");
		const rec = consumeSteer(mailboxRoot(cwd), path);
		expect(rec?.body).toBe("shift focus to tests");
		expect(existsSync(path)).toBe(false);
		expect(listSteer(mailboxRoot(cwd), "scout").length).toBe(0);
	});

	it("preamble v2 teaches the steer channel", () => {
		const p = buildMailboxPreamble("Omp-Agent", mk());
		expect(p).toContain("v2");
		expect(p).toContain("STEER CHANNEL");
		expect(p).toContain("steer-*.json");
	});
});
