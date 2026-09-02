// ABOUTME: Real Herdr NORMAL multi-file smoke with output-backed completion.
// ABOUTME: The completion marker exists only in the fixture test output, never in the prompt.
// Usage: bun tools/e2e/normal-multifile-herdr-e2e.ts <repo-root>

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeHerdrWorkspace } from "./lib-close-workspace.ts";

const repo = process.argv[2];
if (!repo) throw new Error("usage: bun tools/e2e/normal-multifile-herdr-e2e.ts <repo-root>");
const h = (args: string[]) => execFileSync("herdr", args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
const workspace = mkdtempSync(join(tmpdir(), "normal-multifile-e2e-"));
const outputMarker = "NORMAL_FIXTURE_CHECK_7F3A_PASS";
let workspaceId = "";
try {
	writeFileSync(join(workspace, "greeting.ts"), "export function greeting(name: string): string { return `Hello, ${name}`; }\n");
	writeFileSync(join(workspace, "greeting.test.ts"), "import { greeting } from './greeting.ts';\nif (greeting('Pi') !== 'Hello, Pi!') throw new Error('greeting contract failed');\nconsole.log('" + outputMarker + "');\n");
	workspaceId = (JSON.parse(h(["workspace", "create", "--label", "normal-multifile-e2e", "--cwd", workspace])) as any).result.workspace.workspace_id;
	const tab = JSON.parse(execFileSync("bun", [join(repo, "tools/e2e/lib-create-tab.ts"), workspaceId, workspace], { encoding: "utf8" })) as any;
	const paneId = tab.paneId as string;
	const send = (...args: string[]) => execFileSync("herdr", ["pane", ...args], { stdio: ["ignore", "ignore", "ignore"] });
	const readPane = () => stripAnsi(execFileSync("herdr", ["pane", "read", paneId], { encoding: "utf8", timeout: 20_000 }));
	send("send-text", paneId, "pi");
	send("send-keys", paneId, "enter");
	let booted = false;
	for (let i = 0; i < 16; i++) {
		await sleep(2000);
		const text = readPane();
		if (text.includes("Extensions") || text.includes("F I G H T I N G") || /\n│.*\d+\.\d+%\//.test(text)) { booted = true; break; }
	}
	if (!booted) throw new Error(`pi did not boot; tail=${readPane().slice(-600)}`);
	send("send-text", paneId, "/budget 12000 0.15");
	send("send-keys", paneId, "enter");
	await sleep(1000);
	send("send-text", paneId, "Update greeting.ts and greeting.test.ts for this small multi-file change: make greeting accept an optional punctuation argument defaulting to '!'; update the test to expect Hello, Pi!; run the existing test file with bun greeting.test.ts; do not touch any other files.");
	send("send-keys", paneId, "enter");
	await sleep(2000);
	send("send-keys", paneId, "enter");
	let finalText = "";
	for (let i = 0; i < 40; i++) {
		await sleep(2500);
		finalText = readPane();
		if (finalText.includes(outputMarker)) break;
	}
	const greeting = readFileSync(join(workspace, "greeting.ts"), "utf8");
	const test = readFileSync(join(workspace, "greeting.test.ts"), "utf8");
	const journalPath = join(workspace, ".pi", "agent-sessions", "task-journal.jsonl");
	const journal = existsSync(journalPath) ? readFileSync(journalPath, "utf8") : "";
	const passed = finalText.includes(outputMarker) && greeting.includes("punctuation") && greeting.includes("Hello, ${name}${punctuation}") && test.includes("Hello, Pi!");
	if (!passed) throw new Error(`NORMAL multi-file completion missing; files=${JSON.stringify({ greeting, test })}; tail=${finalText.slice(-1800).replace(/\s+/g, " ")}`);
	const usageEvidence = journal.match(/(?:tokens|cost|inputTokens|outputTokens|usage)[^\n]*/gi) ?? [];
	console.log(JSON.stringify({ status: "PASS", mode: "NORMAL", providerBudget: "/budget 12000 0.15", filesChanged: 2, commandOutput: outputMarker, usageEvidence: usageEvidence.slice(0, 6) }));
} finally {
	closeHerdrWorkspace(workspaceId);
	rmSync(workspace, { recursive: true, force: true });
}
