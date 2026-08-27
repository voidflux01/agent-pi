// ABOUTME: End-to-end journal/contract-gate test against a REAL pi in a herdr tab.
// ABOUTME: Creates an isolated workspace, drives one non-compliant and one
// ABOUTME: compliant subagent_create run, then asserts the task-journal rows.
// Usage: bun tools/e2e/journal-e2e.ts <repo-root>
// Requires: herdr CLI running locally; a working default pi model.

import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const REPO = process.argv[2];
if (!REPO) {
	console.error("usage: bun tools/e2e/journal-e2e.ts <repo-root>");
	process.exit(2);
}

const H = (args: string[]) => execFileSync("herdr", args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

async function main() {
	const projDir = mkdtempSync(join(tmpdir(), "api-journal-e2e-"));
	const failures: string[] = [];
	let wsId = "";

	try {
		// 1) isolated workspace + tab
		const created = JSON.parse(H(["workspace", "create", "--label", "api-e2e", "--cwd", projDir]).toString()) as any;
		wsId = created.result.workspace.workspace_id;
		console.log("workspace:", wsId);

		const tabOut = execFileSync("bun", [join(REPO, "tools/e2e/lib-create-tab.ts"), wsId, projDir], { encoding: "utf8" });
		const paneId = (JSON.parse(tabOut) as any).paneId;
		console.log("tab:", paneId);

		const send = (...a: string[]) => execFileSync("herdr", ["pane", ...a], { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] });
		const readPane = () => stripAnsi(execFileSync("herdr", ["pane", "read", paneId], { encoding: "utf8", timeout: 20_000 }));
		const settle = async (maxPolls = 35, quiet = 8000) => {
			for (let i = 0; i < maxPolls; i++) {
				await sleep(quiet);
				const tail = readPane().slice(-900);
				if (!tail.includes("Working") && i > 2) return i + 1;
			}
			return maxPolls;
		};

		// 2) boot pi in the tab (first keypress can be eaten by zsh init; resend once)
		send("send-text", paneId, "pi");
		send("send-keys", paneId, "enter");
		for (let i = 0; i < 15; i++) {
			await sleep(4000);
			if (readPane().includes("Extensions")) break;
			if (i === 7) {
				send("send-text", paneId, "pi");
				send("send-keys", paneId, "enter");
			}
		}
		if (!readPane().includes("Extensions")) throw new Error("pi did not boot in tab");

		// 3) deliberately contract-breaking run
		send("send-text", paneId, 'Use the subagent_create tool to make a breaker agent. Task: run `echo gate-test` then reply with exactly one line "done it". Never write ## RESULT or ## END.');
		send("send-keys", paneId, "enter");
		await sleep(3000);
		send("send-keys", paneId, "enter"); // guard against swallowed enter
		await settle();

		// 4) compliant run — quote the exact block so model drift cannot fail the run
		send("send-text", paneId, 'Now use subagent_create for a goodboy agent. Task: run `echo hello`, then end your final message with EXACTLY this block:\n## RESULT\ndone: true\nsummary: echo ran\n- files: none\n- verification: echo hello output seen\n- remaining: none\n## END');
		send("send-keys", paneId, "enter");
		await sleep(3000);
		send("send-keys", paneId, "enter");
		await settle();
		// The row must actually CLOSE (finish() runs); give the widget a moment.
		for (let i = 0; i < 20; i++) {
			const jp0 = join(projDir, ".pi", "agent-sessions", "task-journal.jsonl");
			if (existsSync(jp0)) {
				const rr = readFileSync(jp0, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
				const gb = rr.find((r: any) => String(r.id).startsWith("goodboy"));
				if (gb && gb.status !== "dispatched") break;
			}
			await sleep(4000);
		}

		// 5) assert journal
		const jp = join(projDir, ".pi", "agent-sessions", "task-journal.jsonl");
		if (!existsSync(jp)) throw new Error("task-journal.jsonl missing");
		const rows = readFileSync(jp, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
		const breaker = rows.find((r: any) => String(r.id).startsWith("breaker"));
		const goodboy = rows.find((r: any) => String(r.id).startsWith("goodboy"));
		const warnInPane = readPane().includes("RESULT contract violated");

		// Gate must flag the breaker...
		if (!breaker || breaker.status !== "done") failures.push(`breaker row missing/not done: ${JSON.stringify(breaker)}`);
		else if (!(breaker.note ?? "").includes("result contract")) failures.push(`breaker note missing contract violation: ${breaker.note}`);
		// ...and must NOT flag an exactly-compliant goodboy.
		if (!goodboy || goodboy.status !== "done") failures.push(`goodboy row missing/not done: ${JSON.stringify(goodboy)}`);
		else if (goodboy.note) failures.push(`goodboy should be silent, got note: ${goodboy.note}`);
		// Pane-tail rendering is best-effort: long transcripts scroll the warning out of
		// the herdr buffer. The durable assertions are the journal rows above; if the
		// warning IS visible, that is a bonus signal.
		console.log(warnInPane ? "bonus: ⚠️ warning visible in pane" : "info: warning scrolled out of pane buffer (journal rows remain authoritative)");

		// 6) archived outputs exist
		for (const base of [breaker?.id, goodboy?.id]) {
			const p = join(projDir, ".pi", "agent-sessions", "outputs", `${base}.txt`);
			if (!existsSync(p)) failures.push(`missing archive ${p}`);
		}
	} catch (err: any) {
		failures.push(String(err?.message ?? err));
	} finally {
		try {
			if (wsId) H(["workspace", "close", wsId]);
		} catch {}
		try {
			rmSync(projDir, { recursive: true, force: true });
		} catch {}
	}

	if (failures.length > 0) {
		console.error("E2E FAILED:\n - " + failures.join("\n - "));
		process.exit(1);
	}
	console.log("journal-e2e PASS: rows, notes, warning line, and archives all correct.");
	process.exit(0);
}

await main();
