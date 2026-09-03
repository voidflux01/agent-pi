// ABOUTME: Guards the herdr visible transport: a pi child in a pane must run
// ABOUTME: pi's real TUI, never a raw JSON event stream (the full-screen-JSON bug).
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrTaskTab, createHerdrTaskTabAsync, herdrEnabled, herdrEnabledAsync, herdrBinary, visiblePiTuiArgs, visiblePiTuiCommand, launchDonePath, launchStartedPath, waitForLaunchStart, writeLaunchScript, herdrPaneRecords, registerHerdrPane, updateHerdrPaneStatus, inspectHerdrPanesAsync, splitDirectionFromRect, parseCallerPaneRect, parseSplitPaneRef, herdrCloseArgs, herdrWorkerLabel, herdrIdentityArgv } from "../lib/herdr-client.ts";

const DONE = "/ext/herdr-done.ts";

// The exact argv shape the SA widget builds for a scout/builder dispatch.
const saArgv = [
	"--mode", "json",
	"-p",
	"--session", "/tmp/sa1.json",
	"--model", "dashscope/qwen3.8-flash",
	"--tools", "read,bash,grep,find,ls",
	"--append-system-prompt", "You are a scout agent.",
	"Count the .ts files under extensions/",
];

// The exact argv shape team/chain/pipeline dispatches build (adds -c resume).
const teamArgv = [
	"--mode", "json",
	"-p",
	"--model", "dashscope/qwen3.8-flash",
	"--tools", "read,bash",
	"--append-system-prompt", "SP",
	"--session", "/tmp/team.json",
	"-c",
	"do the work",
];

describe("herdr transport availability", () => {
	it("prefers Herdr's injected binary path", () => {
		const previous = process.env.HERDR_BIN_PATH;
		try {
			process.env.HERDR_BIN_PATH = "/custom/herdr";
			expect(herdrBinary()).toBe("/custom/herdr");
		} finally {
			if (previous === undefined) delete process.env.HERDR_BIN_PATH;
			else process.env.HERDR_BIN_PATH = previous;
		}
	});

	it("is disabled outside a Herdr environment", () => {
		const previous = process.env.HERDR_ENV;
		try {
			delete process.env.HERDR_ENV;
			expect(herdrEnabled()).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.HERDR_ENV;
			else process.env.HERDR_ENV = previous;
		}
	});
});
	it("async availability check is disabled without Herdr env", async () => {
		const previous = process.env.HERDR_ENV;
		try {
			delete process.env.HERDR_ENV;
			expect(await herdrEnabledAsync()).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.HERDR_ENV;
			else process.env.HERDR_ENV = previous;
		}
	});

describe("visiblePiTuiArgs", () => {
	it("drops the headless flags that make a pane unreadable", () => {
		for (const argv of [saArgv, teamArgv]) {
			const out = visiblePiTuiArgs(argv, DONE);
			expect(out).not.toContain("--mode");
			expect(out).not.toContain("-p");
			expect(out).not.toContain("--print");
			// "--mode json" must not leave its value behind either
			expect(out.filter((t) => t === "json")).toHaveLength(0);
		}
	});

	it("keeps every non-headless token, including the task text last", () => {
		const out = visiblePiTuiArgs(saArgv, DONE);
		for (const kept of ["--session", "/tmp/sa1.json", "--model", "dashscope/qwen3.8-flash", "--tools", "read,bash,grep,find,ls",
			"--append-system-prompt", "You are a scout agent.",
			"Count the .ts files under extensions/"]) {
			expect(out).toContain(kept);
		}
		expect(out[out.length - 1]).toBe("Count the .ts files under extensions/");
		// dropped headless flags plus the appended -e pair and offline worker mode
		expect(out).toHaveLength(saArgv.length - 3 + 2 + 1);
	});

	it("preserves option/value pairs in their original order", () => {
		const out = visiblePiTuiArgs(teamArgv, DONE);
		expect(out[out.indexOf("--model") + 1]).toBe("dashscope/qwen3.8-flash");
		expect(out[out.indexOf("--session") + 1]).toBe("/tmp/team.json");
		expect(out).toContain("-c"); // resume still flows through
		expect(out[out.length - 1]).toBe("do the work");
	});

	it("loads herdr-done inside the existing -e group so the parent learns the turn ended", () => {
		for (const argv of [saArgv, teamArgv]) {
			const out = visiblePiTuiArgs(argv, DONE);
			const lastE = out.lastIndexOf("-e");
			expect(out[lastE + 1]).toBe(DONE);
			// never split an option from its value, and never after the task text
			expect(lastE + 1).toBeLessThan(out.length - 1);
		}
	});

	it("prepends the -e pair when the argv has no extension group", () => {
		const out = visiblePiTuiArgs(["--mode", "json", "-p", "--session", "/tmp/x.json", "task"], DONE);
		expect(out.slice(0, 3)).toEqual(["-e", DONE, "--session"]);
		expect(out[out.length - 1]).toBe("task");
	});

	it("leaves an already-watchable argv untouched", () => {
		const plain = ["--session", "/tmp/x.json", "--model", "m", "task"];
		expect(visiblePiTuiArgs(plain, DONE)).toEqual(plain);
		expect(visiblePiTuiArgs(["--mode", "text", "task"], DONE)).toEqual(["--mode", "text", "task"]);
	});
});

describe("visiblePiTuiCommand", () => {
	it("keeps the pi binary exactly once when given a full command", () => {
		const out = visiblePiTuiCommand(["pi", ...saArgv], DONE);
		expect(out[0]).toBe("pi");
		expect(out.filter((t) => t === "pi")).toHaveLength(1);
		expect(out).not.toContain("--mode");
		expect(out).not.toContain("-p");
		expect(out[out.length - 1]).toBe("Count the .ts files under extensions/");
	});

	it("prepends pi once when the caller omitted the executable", () => {
		const out = visiblePiTuiCommand(saArgv, DONE);
		expect(out[0]).toBe("pi");
		expect(out.filter((t) => t === "pi")).toHaveLength(1);
		expect(out.slice(1)).toEqual(visiblePiTuiArgs(saArgv, DONE));
	});
});

describe("launch marker paths", () => {
	it("clears a stale completion marker before writing a new launch", () => {
		const dir = mkdtempSync(join(tmpdir(), "herdr-stale-"));
		try {
			const stale = launchDonePath(dir, "sa7");
			writeFileSync(stale, "0\n", "utf8");
			writeLaunchScript({ dir, id: "sa7", cwd: dir, command: ["true"], env: {} });
			expect(existsSync(stale)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("launchDonePath matches what writeLaunchScript actually writes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "herdr-launch-"));
		try {
			const refs = writeLaunchScript({ dir, id: "sa7", cwd: dir, command: ["true"], env: {} });
			expect(refs.donePath).toBe(launchDonePath(dir, "sa7"));
			expect(refs.startedPath).toBe(launchStartedPath(dir, "sa7"));
			// HERDR_DONE_PATH must point at the same file the script writes on exit
			expect(readFileSync(refs.scriptPath, "utf8")).toContain(launchDonePath(dir, "sa7"));
			expect(readFileSync(refs.scriptPath, "utf8")).toContain(`printf 'started\n' > '${launchStartedPath(dir, "sa7")}'`);
			writeFileSync(refs.startedPath, "started\n", "utf8");
			expect(await waitForLaunchStart(refs.startedPath, 100)).toBe(true);
		expect(() => launchDonePath(dir, "../escape")).toThrow("Invalid Herdr launch id");
		writeLaunchScript({ dir, id: "safe", cwd: dir, command: ["true"], env: { "BAD;KEY": "x", SAFE_KEY: "quoted'value" } });
		const safeScript = readFileSync(join(dir, "herdr-launch-safe.sh"), "utf8");
		expect(safeScript).not.toContain("BAD;KEY");
		expect(safeScript).toContain("export SAFE_KEY='quoted'\\''value'");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("durable Herdr pane registry", () => {
	it("persists pane refs and status across reads", async () => {
		const dir = mkdtempSync(join(tmpdir(), "herdr-registry-"));
		try {
			const record = {
				key: "sa-1", label: "ap-sa1", cwd: dir,
				ref: { session: "", workspaceId: "w1", tabId: "t1", paneId: "p1" },
				scriptPath: join(dir, "launch.sh"), donePath: join(dir, "done"), startedPath: join(dir, "started"),
				status: "running" as const,
			};
			registerHerdrPane(dir, record);
			expect(herdrPaneRecords(dir)[0]).toMatchObject({ key: "sa-1", status: "running" });
			updateHerdrPaneStatus(dir, "sa-1", "done");
			expect((await inspectHerdrPanesAsync(dir))[0].health).toBe("finished");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("herdr tabs require explicit dispatch", () => {
	it("does not create a tab outside an explicit tool or command context", async () => {
		expect(createHerdrTaskTab("w", "/tmp", "secret")).toBeNull();
		expect(await createHerdrTaskTabAsync("w", "/tmp", "secret")).toBeNull();
	});
});

describe("herdr sibling splits", () => {
	it("submits launch scripts with atomic pane run", () => {
		const client = readFileSync(join(__dirname, "..", "lib", "herdr-client.ts"), "utf8");
		expect(client).toContain('["pane", "run", paneId, ...command]');
		expect(client).not.toContain('["pane", "send-text", paneId, command]');
	});

	it("splits wide panes right and tall panes down", () => {
		expect(splitDirectionFromRect({ width: 160, height: 40 })).toBe("right");
		expect(splitDirectionFromRect({ width: 40, height: 80 })).toBe("down");
		expect(splitDirectionFromRect({ width: 0, height: 10 })).toBe("right");
	});

	it("always sibling-splits a dispatch when the caller pane is known", () => {
		const client = readFileSync(join(__dirname, "..", "lib", "herdr-client.ts"), "utf8");
		expect(client).toContain("preferCallerPaneSplit");
		expect(client).toContain('pane", "split"');
		expect(client).not.toContain("shouldSiblingSplit");
		expect(client).not.toContain("callerTabPaneCount");
	});

	it("reads the caller pane rect from a layout snapshot", () => {
		const stdout = JSON.stringify({
			result: {
				layout: {
					panes: [
						{ pane_id: "w1:p1", rect: { width: 80, height: 24 } },
						{ pane_id: "w1:p2", rect: { width: 200, height: 24 } },
					],
				},
			},
		});
		expect(parseCallerPaneRect(stdout, "w1:p2")).toEqual({ width: 200, height: 24 });
		expect(parseCallerPaneRect(stdout, "missing")).toBeNull();
		expect(parseCallerPaneRect("not-json", "w1:p2")).toBeNull();
	});

	it("parses a split response as a pane-owned worker", () => {
		const stdout = JSON.stringify({
			result: { pane: { pane_id: "w1:p9", tab_id: "w1:t1", workspace_id: "w1" } },
		});
		expect(parseSplitPaneRef(stdout)).toMatchObject({
			paneId: "w1:p9", tabId: "w1:t1", workspaceId: "w1", closeTarget: "pane",
		});
		expect(parseSplitPaneRef("{}", { tabId: "t", workspaceId: "w" })).toBeNull();
	});

	it("closes a split pane, a created tab, and never the caller", () => {
		const previousPane = process.env.HERDR_PANE_ID;
		const previousTab = process.env.HERDR_TAB_ID;
		try {
			process.env.HERDR_PANE_ID = "w1:p1";
			process.env.HERDR_TAB_ID = "w1:t1";
			expect(herdrCloseArgs({
				session: "", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p9", closeTarget: "pane",
			})).toEqual(["pane", "close", "w1:p9"]);
			expect(herdrCloseArgs({
				session: "", workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p8", closeTarget: "tab",
			})).toEqual(["tab", "close", "w1:t2"]);
			expect(herdrCloseArgs({
				session: "", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p7",
			})).toEqual(["pane", "close", "w1:p7"]);
			expect(herdrCloseArgs({
				session: "", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", closeTarget: "pane",
			})).toEqual([]);
		} finally {
			if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
			else process.env.HERDR_PANE_ID = previousPane;
			if (previousTab === undefined) delete process.env.HERDR_TAB_ID;
			else process.env.HERDR_TAB_ID = previousTab;
		}
	});
});

describe("dispatch sites stay watchable (anti-drift)", () => {
	const files = ["agent-team.ts", "agent-chain.ts", "pipeline-team.ts", "subagent-widget.ts", "toolkit-commands.ts"];

	for (const f of files) {
		it(`${f} delegates standard Pi transport to the shared runtime`, () => {
			const src = readFileSync(join(__dirname, "..", f), "utf8");
			expect(src).toContain('from "./lib/dispatch-runtime.ts"');
			expect(src).toContain("runDispatch({");
			// Transport details must not drift back into individual orchestrators.
			expect(src).not.toMatch(/spawn\(\s*["']pi["']/);
		});
	}
});

	it("keeps widget worker mailbox identities unique by SA id", () => {
		const src = readFileSync(join(__dirname, "..", "subagent-widget.ts"), "utf8");
		expect(src).toContain("const mailboxAgent = `sa${state.id}`");
		expect(src).toContain("PI_AGENT_NAME: mailboxAgent");
		expect(src).toContain("buildMailboxPreamble(mailboxAgent");
	});

	it("uses the active Pi context directory for visible subagent work", () => {
		const src = readFileSync(join(__dirname, "..", "subagent-widget.ts"), "utf8");
		expect(src).toContain("const spawnCwd = contextCwd(ctx);");
		expect(src).toContain("cwd: spawnCwd");
	});

	it("does not force --thinking off on child Pi dispatches", () => {
		for (const rel of [
			"subagent-widget.ts",
			"agent-team.ts",
			"agent-chain.ts",
			"pipeline-team.ts",
			"toolkit-commands.ts",
			"lib/toolkit-cli.ts",
		]) {
			const src = readFileSync(join(__dirname, "..", rel), "utf8");
			expect(src).not.toContain('"--thinking", "off"');
		}
	});

	it("marks Herdr workers as quiet without muting the parent", () => {
		for (const rel of ["lib/dispatch-runtime.ts", "lib/toolkit-cli.ts"]) {
			const src = readFileSync(join(__dirname, "..", rel), "utf8");
			expect(src).toContain('PI_WORKER_QUIET: "1"');
		}
		const banner = readFileSync(join(__dirname, "..", "agent-banner.ts"), "utf8");
		expect(banner).toContain('process.env.PI_WORKER_QUIET === "1"');
	});

	it("builds the Herdr command from the full argv without doubling the binary", () => {
		const src = readFileSync(join(__dirname, "..", "lib", "dispatch-runtime.ts"), "utf8");
		expect(src).toContain("visiblePiTuiCommand(spec.command, spec.herdrDoneExtPath)");
		expect(src).not.toMatch(/command:\s*\[spec\.command\[0\]/);
	});

	it("labels herdr panes with the subagent role", () => {
		const src = readFileSync(join(__dirname, "..", "subagent-widget.ts"), "utf8");
		expect(src).toContain("herdrWorkerLabel(");
		expect(src).toContain("PI_PANE_TITLE: paneTitle");
		expect(herdrWorkerLabel("scout", "sa1")).toBe("scout-sa1");
	});

	it("stamps pane, agent chip, overlay title, and owned-tab name", () => {
		const tabCmds = herdrIdentityArgv(
			{ paneId: "w1:p9", tabId: "w1:t9", closeTarget: "tab" },
			{ label: "omp-agent-sa1", agent: "omp-agent", state: "working" },
		);
		expect(tabCmds).toEqual([
			["pane", "rename", "w1:p9", "omp-agent-sa1"],
			["pane", "report-agent", "--source", "agent-pi", "--agent", "omp-agent", "--state", "working", "w1:p9"],
			["pane", "report-metadata", "--source", "agent-pi", "--title", "omp-agent-sa1", "--display-agent", "omp-agent", "w1:p9"],
			["tab", "rename", "w1:t9", "omp-agent-sa1"],
		]);
		const splitCmds = herdrIdentityArgv(
			{ paneId: "w1:p2", tabId: "w1:t1", closeTarget: "pane" },
			{ label: "scout-sa1", agent: "scout-sa1", state: "working" },
		);
		expect(splitCmds.some((c) => c[0] === "tab" && c[1] === "rename")).toBe(false);
	});

	it("opens workers via createHerdrTaskTab which prefers a sibling split", () => {
		const client = readFileSync(join(__dirname, "..", "lib", "herdr-client.ts"), "utf8");
		expect(client).toContain('pane", "split"');
		expect(client).toContain("preferCallerPaneSplit");
		expect(client).toContain('PI_HERDR_SPLIT');
		const runtime = readFileSync(join(__dirname, "..", "lib", "dispatch-runtime.ts"), "utf8");
		expect(runtime).toContain("createHerdrTaskTabAsync");
		expect(runtime).toContain("closeHerdrTabAsync");
		const toolkit = readFileSync(join(__dirname, "..", "lib", "toolkit-cli.ts"), "utf8");
		expect(toolkit).toContain("createHerdrTaskTabAsync");
		expect(toolkit).not.toContain("preferSplit: false");
		expect(toolkit).toContain("stampHerdrPaneIdentityAsync");
		expect(toolkit).toContain("toolkitHerdrAutoCloseMs");
		const sa = readFileSync(join(__dirname, "..", "subagent-widget.ts"), "utf8");
		expect(sa).toContain("runToolkitDispatch");
	});
