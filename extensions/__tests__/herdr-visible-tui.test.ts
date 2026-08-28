// ABOUTME: Guards the herdr visible transport: a pi child in a pane must run
// ABOUTME: pi's real TUI, never a raw JSON event stream (the full-screen-JSON bug).
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrEnabled, herdrEnabledAsync, visiblePiTuiArgs, launchDonePath, launchStartedPath, waitForLaunchStart, writeLaunchScript, herdrPaneRecords, registerHerdrPane, updateHerdrPaneStatus, inspectHerdrPanesAsync } from "../lib/herdr-client.ts";

const DONE = "/ext/herdr-done.ts";

// The exact argv shape the SA widget builds for a scout/builder dispatch.
const saArgv = [
	"--mode", "json",
	"-p",
	"--session", "/tmp/sa1.json",
	"--no-extensions",
	"-e", "/ext/tasks.ts",
	"-e", "/ext/footer.ts",
	"--model", "dashscope/qwen3.8-flash",
	"--tools", "read,grep,find,ls",
	"--thinking", "off",
	"--append-system-prompt", "You are a scout agent.",
	"Count the .ts files under extensions/",
];

// The exact argv shape team/chain/pipeline dispatches build (adds -c resume).
const teamArgv = [
	"--mode", "json",
	"-p",
	"--no-extensions",
	"-e", "/ext/tasks.ts",
	"-e", "/ext/ask-parent.ts",
	"--model", "dashscope/qwen3.8-flash",
	"--tools", "read,bash",
	"--thinking", "off",
	"--append-system-prompt", "SP",
	"--session", "/tmp/team.json",
	"-c",
	"do the work",
];

describe("herdr transport availability", () => {
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
		for (const kept of ["--session", "/tmp/sa1.json", "--no-extensions", "-e", "/ext/tasks.ts",
			"/ext/footer.ts", "--model", "dashscope/qwen3.8-flash", "--tools", "read,grep,find,ls",
			"--thinking", "off", "--append-system-prompt", "You are a scout agent.",
			"Count the .ts files under extensions/"]) {
			expect(out).toContain(kept);
		}
		expect(out[out.length - 1]).toBe("Count the .ts files under extensions/");
		// exactly the two dropped flags plus the appended -e pair
		expect(out).toHaveLength(saArgv.length - 3 + 2);
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

describe("dispatch sites stay watchable (anti-drift)", () => {
	const files = ["agent-team.ts", "agent-chain.ts", "pipeline-team.ts", "subagent-widget.ts"];

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
