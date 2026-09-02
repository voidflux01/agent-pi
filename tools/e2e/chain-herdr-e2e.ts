// ABOUTME: Bounded real Herdr CHAIN workflow smoke.
// ABOUTME: Exercises mode selection, plan-build-review handoff, and chain journal rows.
// Usage: bun tools/e2e/chain-herdr-e2e.ts <repo-root>

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeHerdrWorkspace } from "./lib-close-workspace.ts";

const repo = process.argv[2];
if (!repo) throw new Error("usage: bun tools/e2e/chain-herdr-e2e.ts <repo-root>");
const h = (args: string[]) => execFileSync("herdr", args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

const workspace = mkdtempSync(join(tmpdir(), "chain-herdr-e2e-"));
let workspaceId = "";
let paneId = "";
try {
	workspaceId = (JSON.parse(h(["workspace", "create", "--label", "chain-e2e", "--cwd", workspace])) as any).result.workspace.workspace_id;
	const tab = JSON.parse(execFileSync("bun", [join(repo, "tools/e2e/lib-create-tab.ts"), workspaceId, workspace], { encoding: "utf8" })) as any;
	paneId = tab.paneId;
	const send = (...args: string[]) => execFileSync("herdr", ["pane", ...args], { stdio: ["ignore", "ignore", "ignore"] });
	const readPane = () => stripAnsi(execFileSync("herdr", ["pane", "read", paneId], { encoding: "utf8", timeout: 20_000 }));
	const readRows = () => {
		const path = join(workspace, ".pi", "agent-sessions", "task-journal.jsonl");
		if (!existsSync(path)) return [] as any[];
		return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	};

	send("send-text", paneId, "pi");
	send("send-keys", paneId, "enter");
	let booted = false;
	for (let i = 0; i < 18; i++) {
		await sleep(2000);
		const text = readPane();
		if (text.includes("Extensions") || text.includes("F I G H T I N G") || /\n│.*\d+\.\d+%\//.test(text)) { booted = true; break; }
		if (i === 8) { send("send-text", paneId, "pi"); send("send-keys", paneId, "enter"); }
	}
	if (!booted) throw new Error(`pi did not boot; tail=${readPane().slice(-500)}`);

	send("send-text", paneId, "/budget 24000 0.20");
	send("send-keys", paneId, "enter");
	await sleep(1000);
	send("send-text", paneId, "Use set_mode to switch to CHAIN, then run_chain with chain plan-build-review for this tiny disposable task: verify that `printf chain-ok` produces chain-ok. Do not make repository changes. Wait for all three chain steps to finish, then reply exactly CHAIN-TASK-PASS.");
	send("send-keys", paneId, "enter");
	await sleep(2000);
	send("send-keys", paneId, "enter");

	let finalText = "";
	for (let i = 0; i < 60; i++) {
		await sleep(3000);
		finalText = readPane();
		const chainRows = readRows().filter((row: any) => row.kind === "chain");
		const terminal = chainRows.filter((row: any) => row.status === "done" || row.status === "error");
		if (finalText.includes("CHAIN-TASK-PASS") && terminal.length >= 3) break;
	}
	const chainRows = readRows().filter((row: any) => row.kind === "chain");
	const terminal = chainRows.filter((row: any) => row.status === "done" || row.status === "error");
	if (!finalText.includes("CHAIN-TASK-PASS") || terminal.length < 3 || terminal.some((row: any) => row.status !== "done")) {
		throw new Error(`CHAIN task incomplete; rows=${JSON.stringify(chainRows).slice(0, 1800)}; tail=${finalText.slice(-1200).replace(/\s+/g, " ")}`);
	}
	console.log(JSON.stringify({ status: "PASS", mode: "CHAIN", providerBudget: "/budget 24000 0.20", chainRows: chainRows.length }));
} finally {
	closeHerdrWorkspace(workspaceId);
	rmSync(workspace, { recursive: true, force: true });
}
