// ABOUTME: End-to-end handoff test against a REAL pi in a herdr tab.
// ABOUTME: Seeds an unfinished snapshot, verifies startup discovery and /handoff rendering.
// Usage: bun tools/e2e/handoff-e2e.ts <repo-root>
// Requires: herdr CLI running locally; a working default pi model.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { closeHerdrWorkspace } from "./lib-close-workspace.ts";

const REPO = process.argv[2];
if (!REPO) {
	console.error("usage: bun tools/e2e/handoff-e2e.ts <repo-root>");
	process.exit(2);
}

const H = (args: string[]) => execFileSync("herdr", args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

async function main() {
	const workspace = mkdtempSync(join(tmpdir(), "handoff-e2e-"));
	let workspaceId = "";
	let paneId = "";
	const failures: string[] = [];
	try {
		const created = JSON.parse(H(["workspace", "create", "--label", "handoff-e2e", "--cwd", workspace]).toString()) as any;
		workspaceId = created.result.workspace.workspace_id;
		const handoffDir = join(workspace, ".pi");
		mkdirSync(handoffDir, { recursive: true });
		writeFileSync(join(handoffDir, "handoff.json"), JSON.stringify({
			version: 1,
			workspace,
			sessionId: "previous-session",
			status: "in_progress",
			objective: "handoff E2E task",
			mode: "PLAN",
			tasks: [{ id: 1, text: "Verify continuity", status: "inprogress" }],
			children: [],
			nextAction: "Run the continuity check",
			updatedAt: new Date().toISOString(),
		}, null, 2) + "\n");
		const tabOut = execFileSync("bun", [join(REPO, "tools/e2e/lib-create-tab.ts"), workspaceId, workspace], { encoding: "utf8" });
		paneId = (JSON.parse(tabOut) as any).paneId;
		const send = (...args: string[]) => execFileSync("herdr", ["pane", ...args], { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] });
		const readPane = () => stripAnsi(execFileSync("herdr", ["pane", "read", paneId], { encoding: "utf8", timeout: 20_000 }));

		send("send-text", paneId, "pi");
		send("send-keys", paneId, "enter");
		let booted = false;
		for (let i = 0; i < 20; i++) {
			await sleep(2000);
			const text = readPane();
			if (text.includes("Extensions") || text.includes("F I G H T I N G") || /\n│.*\d+\.\d+%\//.test(text)) {
				booted = true;
				break;
			}
			if (text.includes("Unfinished handoff found")) break;
			if (i === 8) {
				send("send-text", paneId, "pi");
				send("send-keys", paneId, "enter");
			}
		}

		const boot = readPane();
		if (!booted && !(boot.includes("Extensions") || boot.includes("F I G H T I N G") || /\n│.*\d+\.\d+%\//.test(boot))) {
			failures.push(`pi did not boot in isolated pane; tail=${boot.slice(-400).replace(/\s+/g, " ")}`);
		}
		if (!boot.includes("Unfinished handoff found: handoff E2E task")) failures.push("startup did not discover unfinished handoff");

		send("send-text", paneId, "/handoff");
		send("send-keys", paneId, "enter");
		await sleep(1500);
		const rendered = readPane();
		if (!rendered.includes("Objective: handoff E2E task")) failures.push("/handoff did not render objective");
		if (!rendered.includes("Next action: Run the continuity check")) failures.push("/handoff did not render next action");

		const saved = join(workspace, ".pi", "handoff.json");
		if (!existsSync(saved)) failures.push("handoff.json disappeared during session");
		else if (!(JSON.parse(readFileSync(saved, "utf8")) as any).objective) failures.push("handoff.json lost objective");
	} catch (error: any) {
		failures.push(String(error?.message ?? error));
	} finally {
		closeHerdrWorkspace(workspaceId);
		try { rmSync(workspace, { recursive: true, force: true }); } catch {}
	}

	if (failures.length) {
		console.error("handoff-e2e FAILED:\n - " + failures.join("\n - "));
		process.exit(1);
	}
	console.log("handoff-e2e PASS: startup discovery, /handoff rendering, and durable snapshot verified.");
}

await main();
