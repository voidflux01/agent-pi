// ABOUTME: Low-cost real Herdr PLAN task smoke.
// ABOUTME: Exercises set_mode -> show_plan in a real Pi TUI without workers or file writes.
// Usage: bun tools/e2e/plan-herdr-e2e.ts <repo-root>

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeHerdrWorkspace } from "./lib-close-workspace.ts";

const repo = process.argv[2];
if (!repo) throw new Error("usage: bun tools/e2e/plan-herdr-e2e.ts <repo-root>");
const h = (args: string[]) => execFileSync("herdr", args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

const workspace = mkdtempSync(join(tmpdir(), "plan-herdr-e2e-"));
let workspaceId = "";
let paneId = "";
try {
	workspaceId = (JSON.parse(h(["workspace", "create", "--label", "plan-e2e", "--cwd", workspace])) as any).result.workspace.workspace_id;
	const tab = JSON.parse(execFileSync("bun", [join(repo, "tools/e2e/lib-create-tab.ts"), workspaceId, workspace], { encoding: "utf8" })) as any;
	paneId = tab.paneId;
	const send = (...args: string[]) => execFileSync("herdr", ["pane", ...args], { stdio: ["ignore", "ignore", "ignore"] });
	const readPane = () => stripAnsi(execFileSync("herdr", ["pane", "read", paneId], { encoding: "utf8", timeout: 20_000 }));

	send("send-text", paneId, "pi");
	send("send-keys", paneId, "enter");
	let booted = false;
	for (let i = 0; i < 18; i++) {
		await sleep(2000);
		const text = readPane();
		if (text.includes("Extensions") || text.includes("F I G H T I N G") || /\n│.*\d+\.\d+%\//.test(text)) {
			booted = true;
			break;
		}
		if (i === 8) {
			send("send-text", paneId, "pi");
			send("send-keys", paneId, "enter");
		}
	}
	if (!booted) throw new Error(`pi did not boot; tail=${readPane().slice(-500)}`);

	send("send-text", paneId, "/budget 8000 0.10");
	send("send-keys", paneId, "enter");
	await sleep(1000);
	send("send-text", paneId, "Use set_mode to switch to PLAN, then call show_plan with exactly one read-only step: inspect the current workspace without changing files. After the plan result is displayed, reply with exactly PLAN-TASK-PASS.");
	send("send-keys", paneId, "enter");
	await sleep(2000);
	send("send-keys", paneId, "enter");

	let finalText = "";
	for (let i = 0; i < 30; i++) {
		await sleep(3000);
		finalText = readPane();
		if (finalText.includes("PLAN-TASK-PASS")) break;
	}
	const passed = finalText.includes("PLAN-TASK-PASS") && finalText.toLowerCase().includes("plan");
	if (!passed) throw new Error(`PLAN task marker missing; tail=${finalText.slice(-1200).replace(/\s+/g, " ")}`);
	console.log(JSON.stringify({ status: "PASS", mode: "PLAN", providerBudget: "/budget 8000 0.10", taskJournalPresent: existsSync(join(workspace, ".pi", "agent-sessions", "task-journal.jsonl")) }));
} finally {
	closeHerdrWorkspace(workspaceId);
	rmSync(workspace, { recursive: true, force: true });
}
