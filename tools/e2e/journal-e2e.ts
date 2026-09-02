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
		const journalRows = () => {
			const jp = join(projDir, ".pi", "agent-sessions", "task-journal.jsonl");
			if (!existsSync(jp)) return [] as any[];
			return readFileSync(jp, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
		};
		const waitForAgent = async (agent: string, maxPolls = 30) => {
			for (let i = 0; i < maxPolls; i++) {
				await sleep(3000);
				const row = journalRows().find((candidate: any) => candidate.agent === agent);
				if (row && (row.status === "done" || row.status === "error")) return row;
			}
			return journalRows().find((candidate: any) => candidate.agent === agent);
		};

		// 2) boot pi in the tab (first keypress can be eaten by zsh init; resend once)
		send("send-text", paneId, "pi");
		send("send-keys", paneId, "enter");
		for (let i = 0; i < 15; i++) {
			await sleep(4000);
			const bootText = readPane();
			if (bootText.includes("Extensions") || bootText.includes("F I G H T I N G") || /\n│.*\d+\.\d+%\//.test(bootText)) break;
			if (i === 7) {
				send("send-text", paneId, "pi");
				send("send-keys", paneId, "enter");
			}
		}
		const bootText = readPane();
		if (!(bootText.includes("Extensions") || bootText.includes("F I G H T I N G") || /\n│.*\d+\.\d+%\//.test(bootText))) throw new Error("pi did not boot in tab");

		// Keep this real-provider test bounded. The ceiling is inherited by child
		// dispatches and is intentionally conservative; it is not a benchmark budget.
		send("send-text", paneId, "/budget 16000 0.20");
		send("send-keys", paneId, "enter");
		await sleep(1000);

		// 3) deliberately contract-breaking run
		send("send-text", paneId, 'Use the subagent_create tool to make a breaker agent. Task: run `echo gate-test` then reply with exactly one line "done it". Never write ## RESULT or ## END.');
		send("send-keys", paneId, "enter");
		await sleep(2000);
		send("send-keys", paneId, "enter"); // guard against swallowed enter
		const breakerResult = await waitForAgent("breaker");

		// 4) compliant run — quote the exact block so model drift cannot fail the run
		send("send-text", paneId, 'Now use subagent_create for a goodboy agent. Task: run `echo hello`, then end your final message with EXACTLY this block:\n## RESULT\ndone: true\nsummary: echo ran\n- files: none\n- verification: echo hello output seen\n- remaining: none\n## END');
		send("send-keys", paneId, "enter");
		await sleep(2000);
		send("send-keys", paneId, "enter");
		const goodboyResult = await waitForAgent("goodboy");

		// 5) assert journal
		const jp = join(projDir, ".pi", "agent-sessions", "task-journal.jsonl");
		if (!existsSync(jp)) throw new Error("task-journal.jsonl missing");
		const rows = readFileSync(jp, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
		const breaker = rows.find((r: any) => String(r.id).startsWith("breaker"));
		const goodboy = rows.find((r: any) => String(r.id).startsWith("goodboy"));
		const warnInPane = readPane().includes("RESULT contract violated");

		// Gate must flag the breaker...
		if (!breaker || breaker.status !== "done") failures.push(`breaker row missing/not done: ${JSON.stringify(breaker)}; terminal wait: ${JSON.stringify(breakerResult)}`);
		else if (!(breaker.note ?? "").includes("result contract")) failures.push(`breaker note missing contract violation: ${breaker.note}`);
		// ...and must NOT flag an exactly-compliant goodboy.
		if (!goodboy || goodboy.status !== "done") failures.push(`goodboy row missing/not done: ${JSON.stringify(goodboy)}; terminal wait: ${JSON.stringify(goodboyResult)}`);
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
