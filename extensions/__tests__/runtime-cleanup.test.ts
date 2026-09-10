import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cleanupRuntimeArtifacts, cleanupSessionScrap, cleanupTerminalRuns, cleanupVerifierTranscripts, LAST_SWEEP_MARKER } from "../lib/runtime-cleanup.ts";

let cwd = "";
const OLD = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "runtime-cleanup-"));
});
afterEach(() => { try { rmSync(cwd, { recursive: true, force: true }); } catch { } });

function write(rel: string, age: Date = new Date()): string {
	const file = join(cwd, rel);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, "x\n");
	utimesSync(file, age, age);
	return file;
}

describe("retention sweep", () => {
	it("removes old files, keeps fresh files, and reaps emptied dirs", () => {
		write(".pi/agent-sessions/compositions/run-old/events.jsonl", OLD);
		const fresh = write(".pi/agent-sessions/compositions/run-fresh/events.jsonl");
		write(".context/evidence/old.jsonl", OLD);
		const kept = write(".context/evidence/new.jsonl");

		cleanupRuntimeArtifacts(cwd);

		expect(existsSync(join(cwd, ".pi/agent-sessions/compositions/run-old"))).toBe(false); // emptied → reaped
		expect(existsSync(fresh)).toBe(true);
		expect(existsSync(join(cwd, ".context/evidence/old.jsonl"))).toBe(false);
		expect(existsSync(kept)).toBe(true);
	});

	it("sweeps home subagent dirs as the crash-debris net", () => {
		const home = mkdtempSync(join(tmpdir(), "runtime-cleanup-home-"));
		const old = join(home, "subagents/compositions/run-old/events.jsonl");
		mkdirSync(dirname(old), { recursive: true });
		writeFileSync(old, "x\n");
		utimesSync(old, OLD, OLD);
		const freshDir = join(home, "subagents/compositions/run-fresh");
		mkdirSync(freshDir, { recursive: true });
		const fresh = join(freshDir, "events.jsonl");
		writeFileSync(fresh, "x\n");

		cleanupRuntimeArtifacts(cwd, 7 * 24 * 60 * 60 * 1000, 0, [home]);

		expect(existsSync(dirname(old))).toBe(false); // emptied → reaped
		expect(existsSync(fresh)).toBe(true);
	});
});

describe("session scrap cleanup", () => {
	it("deletes capture and grill dirs at shutdown", () => {
		write(".pi/debug-captures/tui.png");
		write(".pi/web-test-captures/page.png");
		write(".pi/grill-me/state.json");
		write(".context/research-sessions/keep.json"); // not scrap

		cleanupSessionScrap(cwd);

		expect(existsSync(join(cwd, ".pi/debug-captures"))).toBe(false);
		expect(existsSync(join(cwd, ".pi/web-test-captures"))).toBe(false);
		expect(existsSync(join(cwd, ".pi/grill-me"))).toBe(false);
		expect(existsSync(join(cwd, ".context/research-sessions/keep.json"))).toBe(true);
	});
});

describe("terminal run cleanup", () => {
	it("deletes finished runs (no active.json) but keeps in-flight ones", () => {
		write(".pi/agent-sessions/compositions/done/events.jsonl");
		write(".pi/agent-sessions/compositions/running/events.jsonl");
		write(".pi/agent-sessions/compositions/running/active.json");

		cleanupTerminalRuns(cwd);

		expect(existsSync(join(cwd, ".pi/agent-sessions/compositions/done"))).toBe(false);
		expect(existsSync(join(cwd, ".pi/agent-sessions/compositions/running"))).toBe(true);
	});

	it("reaps terminal runs in per-session nested compositions dirs", () => {
		write(".pi/agent-sessions/verifier/compositions/done/events.jsonl");
		write(".pi/agent-sessions/verifier/compositions/running/events.jsonl");
		write(".pi/agent-sessions/verifier/compositions/running/active.json");

		cleanupTerminalRuns(cwd);

		expect(existsSync(join(cwd, ".pi/agent-sessions/verifier/compositions/done"))).toBe(false);
		expect(existsSync(join(cwd, ".pi/agent-sessions/verifier/compositions/running"))).toBe(true);
	});

	it("reaps terminal home subagent runs (parent-shutdown net)", () => {
		const home = mkdtempSync(join(tmpdir(), "runtime-cleanup-home-"));
		const base = join(home, "subagents/compositions");
		mkdirSync(join(base, "done"), { recursive: true });
		writeFileSync(join(base, "done/events.jsonl"), "x\n");
		mkdirSync(join(base, "running"), { recursive: true });
		writeFileSync(join(base, "running/active.json"), "x\n");

		cleanupTerminalRuns(cwd, base);

		expect(existsSync(join(base, "done"))).toBe(false);
		expect(existsSync(join(base, "running"))).toBe(true);
	});
});

describe("verifier transcript cleanup", () => {
	it("deletes all verifier session transcripts", () => {
		write(".pi/agent-sessions/verifier/verifier-deadbeef-1.jsonl");
		write(".pi/agent-sessions/verifier/verifier-deadbeef-2.jsonl");
		write(".pi/agent-sessions/verifier/state.json"); // non-transcript sibling survives

		cleanupVerifierTranscripts(cwd);

		const dir = join(cwd, ".pi/agent-sessions/verifier");
		expect(existsSync(join(dir, "verifier-deadbeef-1.jsonl"))).toBe(false);
		expect(existsSync(join(dir, "verifier-deadbeef-2.jsonl"))).toBe(false);
		expect(existsSync(join(dir, "state.json"))).toBe(true);
	});
});

describe("throttle", () => {
	it("skips the sweep while the marker is fresh, runs after it ages out", () => {
		// First run sweeps and records the marker.
		write(".pi/agent-sessions/compositions/run-a/events.jsonl", OLD);
		cleanupRuntimeArtifacts(cwd);
		expect(existsSync(join(cwd, ".pi/agent-sessions/compositions/run-a"))).toBe(false);

		// A second old file appears; the fresh marker suppresses the next sweep.
		write(".pi/agent-sessions/compositions/run-b/events.jsonl", OLD);
		cleanupRuntimeArtifacts(cwd);
		expect(existsSync(join(cwd, ".pi/agent-sessions/compositions/run-b/events.jsonl"))).toBe(true);

		// Backdate the marker past the throttle window: the sweep runs again.
		writeFileSync(join(cwd, LAST_SWEEP_MARKER), String(Date.now() - 13 * 60 * 60 * 1000));
		cleanupRuntimeArtifacts(cwd);
		expect(existsSync(join(cwd, ".pi/agent-sessions/compositions/run-b"))).toBe(false);
	});
});