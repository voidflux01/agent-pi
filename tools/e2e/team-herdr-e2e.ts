// ABOUTME: Bounded real Herdr TEAM worker smoke.
// ABOUTME: Exercises TEAM mode -> dispatch_agent -> worker journal completion.
// Usage: bun tools/e2e/team-herdr-e2e.ts <repo-root>

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeHerdrWorkspace } from "./lib-close-workspace.ts";

const repo = process.argv[2];
if (!repo) throw new Error("usage: bun tools/e2e/team-herdr-e2e.ts <repo-root>");
const h = (args: string[]) => execFileSync("herdr", args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

const workspace = mkdtempSync(join(tmpdir(), "team-herdr-e2e-"));
let workspaceId = "";
let paneId = "";
try {
	workspaceId = (JSON.parse(h(["workspace", "create", "--label", "team-e2e", "--cwd", workspace])) as any).result.workspace.workspace_id;
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

	send("send-text", paneId, "/budget 8000 0.08");
	send("send-keys", paneId, "enter");
	await sleep(1000);
	send("send-text", paneId, "Use set_mode to switch to TEAM. Then use dispatch_agent exactly once with the REVIEWER role for this read-only task: run `printf team-ok`, report the output, and finish with a valid ## RESULT block. Wait for the worker result, then reply exactly TEAM-TASK-PASS.");
	send("send-keys", paneId, "enter");
	await sleep(2000);
	send("send-keys", paneId, "enter");

	let finalText = "";
	for (let i = 0; i < 45; i++) {
		await sleep(3000);
		finalText = readPane();
		const teamRows = readRows().filter((row: any) => row.kind === "team");
		if (finalText.includes("TEAM-TASK-PASS") && teamRows.some((row: any) => String(row.agent).toLowerCase() === "reviewer" && row.status === "done")) break;
	}
	const teamRows = readRows().filter((row: any) => row.kind === "team");
	if (!finalText.includes("TEAM-TASK-PASS") || !teamRows.some((row: any) => String(row.agent).toLowerCase() === "reviewer" && row.status === "done")) {
		throw new Error(`TEAM task incomplete; rows=${JSON.stringify(teamRows).slice(0, 1400)}; tail=${finalText.slice(-1000).replace(/\s+/g, " ")}`);
	}
	console.log(JSON.stringify({ status: "PASS", mode: "TEAM", providerBudget: "/budget 8000 0.08", teamRows: teamRows.length }));
} finally {
	closeHerdrWorkspace(workspaceId);
	rmSync(workspace, { recursive: true, force: true });
}
