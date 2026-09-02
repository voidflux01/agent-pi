// ABOUTME: Provider-free real Pi/Herdr MCP failure-boundary smoke.
// ABOUTME: Uses an isolated MCP config whose stdio server exits immediately.
// Usage: bun tools/e2e/mcp-failure-e2e.ts <repo-root>

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeHerdrWorkspace } from "./lib-close-workspace.ts";

const repo = process.argv[2];
if (!repo) throw new Error("usage: bun tools/e2e/mcp-failure-e2e.ts <repo-root>");
const h = (args: string[]) => execFileSync("herdr", args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

const workspace = mkdtempSync(join(tmpdir(), "mcp-failure-e2e-"));
const configPath = join(workspace, "mcp.json");
writeFileSync(configPath, JSON.stringify({ mcpServers: { broken: { command: process.execPath, args: ["-e", "process.exit(17)"], directTools: true } } }) + "\n");
let workspaceId = "";
try {
	workspaceId = (JSON.parse(h(["workspace", "create", "--label", "mcp-failure-e2e", "--cwd", workspace])) as any).result.workspace.workspace_id;
	const tab = JSON.parse(execFileSync("bun", [join(repo, "tools/e2e/lib-create-tab.ts"), workspaceId, workspace], { encoding: "utf8" })) as any;
	const paneId = tab.paneId as string;
	const send = (...args: string[]) => execFileSync("herdr", ["pane", ...args], { stdio: ["ignore", "ignore", "ignore"] });
	const readPane = () => stripAnsi(execFileSync("herdr", ["pane", "read", paneId], { encoding: "utf8", timeout: 20_000 }));
	send("send-text", paneId, `pi --mcp-config ${configPath}`);
	send("send-keys", paneId, "enter");
	let booted = false;
	for (let i = 0; i < 18; i++) {
		await sleep(2000);
		const text = readPane();
		if (text.includes("Extensions") || text.includes("F I G H T I N G") || /\n│.*\d+\.\d+%\//.test(text)) { booted = true; break; }
	}
	if (!booted) throw new Error(`pi did not boot; tail=${readPane().slice(-500)}`);
	send("send-text", paneId, "/mcp");
	send("send-keys", paneId, "enter");
	await sleep(5000);
	const rendered = readPane();
	if (!rendered.includes("broken")) throw new Error(`MCP failure server missing from status; tail=${rendered.slice(-1200)}`);
	if (!/(failed|disconnected|not listening)/i.test(rendered)) throw new Error(`MCP failure was not surfaced; tail=${rendered.slice(-1600)}`);
	console.log(JSON.stringify({ status: "PASS", provider: "none", server: "broken", failureSurfaced: true }));
} finally {
	closeHerdrWorkspace(workspaceId);
	rmSync(workspace, { recursive: true, force: true });
}
