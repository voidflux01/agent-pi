// ABOUTME: Bounded real Herdr PIPELINE workflow smoke.
// ABOUTME: Exercises understand -> plan -> build -> review and durable phase rows.
// Usage: bun tools/e2e/pipeline-herdr-e2e.ts <repo-root>

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeHerdrWorkspace } from "./lib-close-workspace.ts";

const repo = process.argv[2];
if (!repo) throw new Error("usage: bun tools/e2e/pipeline-herdr-e2e.ts <repo-root>");
const h = (args: string[]) => execFileSync("herdr", args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const modelArg = process.env.PIPELINE_E2E_MODEL ? ` --model ${shellQuote(process.env.PIPELINE_E2E_MODEL)}` : "";

const workspace = mkdtempSync(join(tmpdir(), "pipeline-herdr-e2e-"));
let workspaceId = "";
let paneId = "";
try {
	workspaceId = (JSON.parse(h(["workspace", "create", "--label", "pipeline-e2e", "--cwd", workspace])) as any).result.workspace.workspace_id;
	const tab = JSON.parse(execFileSync("bun", [join(repo, "tools/e2e/lib-create-tab.ts"), workspaceId, workspace], { encoding: "utf8" })) as any;
	paneId = tab.paneId;
	const send = (...args: string[]) => execFileSync("herdr", ["pane", ...args], { stdio: ["ignore", "ignore", "ignore"] });
	const readPane = () => stripAnsi(execFileSync("herdr", ["pane", "read", paneId], { encoding: "utf8", timeout: 20_000 }));
	const readRows = () => {
		const path = join(workspace, ".pi", "agent-sessions", "task-journal.jsonl");
		if (!existsSync(path)) return [] as any[];
		return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	};

	const piCommand = `pi -e ${shellQuote(repo)}${modelArg}`;
	send("send-text", paneId, piCommand);
	send("send-keys", paneId, "enter");
	let booted = false;
	for (let i = 0; i < 18; i++) {
		await sleep(2000);
		const text = readPane();
		if (text.includes("Extensions") || text.includes("F I G H T I N G") || /\n│.*\d+\.\d+%\//.test(text)) { booted = true; break; }
		if (i === 8) { send("send-text", paneId, piCommand); send("send-keys", paneId, "enter"); }
	}
	if (!booted) throw new Error(`pi did not boot; tail=${readPane().slice(-500)}`);

	send("send-text", paneId, "/budget 32000 0.25");
	send("send-keys", paneId, "enter");
	await sleep(1000);
	send("send-text", paneId, "/pipeline");
	send("send-keys", paneId, "enter");
	await sleep(1000);
	// Herdr sends slash-command arguments through the interactive picker in
	// this TUI; the first option is the configured four-phase smoke pipeline.
	send("send-keys", paneId, "enter");
	await sleep(1000);
	send("send-text", paneId, "Run the active four-phase PIPELINE for this workflow-protocol smoke task: verify that `printf pipeline-ok` outputs pipeline-ok. Do not modify the repository. Treat this as COMPLEX for the purpose of exercising the pipeline: do not skip UNDERSTAND or any configured phase. In PIPELINE mode never call show_plan or show_spec. Follow the exact loop for each phase: call subagent_create with the configured worker name, join:true, and the phase task; wait for its bounded ## RESULT, then immediately call advance_phase with that summary. Repeat for UNDERSTAND, PLAN, BUILD, and REVIEW; after the final phase returns, reply exactly PIPELINE-TASK-PASS.");
	send("send-keys", paneId, "enter");

	let finalText = "";
	for (let i = 0; i < 75; i++) {
		await sleep(3000);
		finalText = readPane();
		const rows = readRows().filter((row: any) => (row.kind === "pipeline" || row.kind === "sa") && row.mode === "PIPELINE");
		const terminal = rows.filter((row: any) => row.status === "done" || row.status === "error");
		if (finalText.includes("PIPELINE-TASK-PASS") && terminal.length >= 3) break;
	}
	const rows = readRows().filter((row: any) => (row.kind === "pipeline" || row.kind === "sa") && row.mode === "PIPELINE");
	const terminal = rows.filter((row: any) => row.status === "done" || row.status === "error");
	if (!finalText.includes("PIPELINE-TASK-PASS") || terminal.length < 3 || terminal.some((row: any) => row.status !== "done")) {
		throw new Error(`PIPELINE task incomplete; rows=${JSON.stringify(rows).slice(0, 2200)}; tail=${finalText.slice(-1200).replace(/\s+/g, " ")}`);
	}
	console.log(JSON.stringify({ status: "PASS", mode: "PIPELINE", providerBudget: "/budget 32000 0.25", pipelineRows: rows.length }));
} finally {
	closeHerdrWorkspace(workspaceId);
	rmSync(workspace, { recursive: true, force: true });
}
