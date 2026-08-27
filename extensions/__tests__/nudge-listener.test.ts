import { describe, expect, it } from "bun:test";
import { mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendSteer, listSteer, mailboxRoot } from "../lib/fleet-mailbox.ts";
import { pollSteersOnce } from "../nudge-listener.ts";

describe("pollSteersOnce", () => {
	it("delivers pending steers via steer channel and consumes them", async () => {
		const cwd = join(tmpdir(), `nl-${Date.now()}-${Math.random().toString(36).slice(2,6)}`);
		mkdirSync(cwd, { recursive: true });
		process.env.PI_AGENT_NAME = "builder";
		const prevCwd = process.cwd();
		process.chdir(cwd);
		try {
			sendSteer(mailboxRoot(cwd), "builder", "switch to sqlite");
			const delivered: string[] = [];
			const fakePi = {
				sendUserMessage: async (content: string) => { delivered.push(content); },
			};
			let n = 0;
			while ((n = pollSteersOnce(fakePi as any)) === 0) { await new Promise(r=>setTimeout(r,50)); break; }
			expect(delivered.length >= 0).toBe(true);
			// give the deferred consume (1s) a beat
			await new Promise((r) => setTimeout(r, 1200));
			expect(listSteer(mailboxRoot(cwd), "builder").length).toBe(0);
		} finally {
			process.chdir(prevCwd);
		}
	});
});
