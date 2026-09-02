// ABOUTME: Provider-free real Pi/Herdr TEAM restart-boundary smoke.
// ABOUTME: Verifies startup retains only a safe unfinished TEAM session.
// Usage: bun tools/e2e/team-recovery-e2e.ts <repo-root>

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeHerdrWorkspace } from "./lib-close-workspace.ts";

const repo = process.argv[2];
if (!repo) throw new Error("usage: bun tools/e2e/team-recovery-e2e.ts <repo-root>");
const h = (args: string[]) => execFileSync("herdr", args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

const workspace = realpathSync(mkdtempSync(join(tmpdir(), "team-recovery-e2e-")));
const sessionDir = join(workspace, ".pi", "agent-sessions");

let workspaceId = "";
try {
	workspaceId = (JSON.parse(h(["workspace", "create", "--label", "team-recovery-e2e", "--cwd", workspace])) as any).result.workspace.workspace_id;
	// Seed only after Herdr has created/initialized the workspace directory.
	mkdirSync(sessionDir, { recursive: true });
	const now = Date.now();
	const sessionSeed = (id: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(now).toISOString(), cwd: workspace }) + "\n";
	writeFileSync(join(sessionDir, "builder.json"), sessionSeed("team-builder-restart"));
	writeFileSync(join(sessionDir, "reviewer.json"), sessionSeed("team-reviewer-done"));
	writeFileSync(join(sessionDir, "task-journal.jsonl"), [
		JSON.stringify({ version: 1, id: "team-builder-restart", kind: "team", mode: "TEAM", agent: "Builder", task: "resume safely", status: "error", startedAt: now - 5000, updatedAt: now - 1000, sessionFile: join(sessionDir, "builder.json") }),
		JSON.stringify({ version: 1, id: "team-reviewer-done", kind: "team", mode: "TEAM", agent: "Reviewer", task: "already complete", status: "done", startedAt: now - 6000, updatedAt: now - 2000, sessionFile: join(sessionDir, "reviewer.json") }),
	].join("\n") + "\n");
	const tab = JSON.parse(execFileSync("bun", [join(repo, "tools/e2e/lib-create-tab.ts"), workspaceId, workspace], { encoding: "utf8" })) as any;
	const paneId = tab.paneId as string;
	const send = (...args: string[]) => execFileSync("herdr", ["pane", ...args], { stdio: ["ignore", "ignore", "ignore"] });
	const readPane = () => stripAnsi(execFileSync("herdr", ["pane", "read", paneId], { encoding: "utf8", timeout: 20_000 }));

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

	if (!existsSync(join(sessionDir, "builder.json"))) throw new Error("unfinished Builder session was deleted on startup");
	if (existsSync(join(sessionDir, "reviewer.json"))) throw new Error("completed Reviewer session was retained unexpectedly");
	const rows = readFileSync(join(sessionDir, "task-journal.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	if (!rows.some((row: any) => row.id === "team-builder-restart")) throw new Error("unfinished TEAM journal row disappeared");
	console.log(JSON.stringify({ status: "PASS", provider: "none", retained: "builder.json", removedCompleted: "reviewer.json", rows: rows.length }));
} finally {
	closeHerdrWorkspace(workspaceId);
	rmSync(workspace, { recursive: true, force: true });
}
