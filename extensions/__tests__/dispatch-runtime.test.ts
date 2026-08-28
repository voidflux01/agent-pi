// ABOUTME: Contract tests for the shared standard Pi dispatch runtime.
// ABOUTME: A fake child proves stdout, stderr, cancellation boundaries, and journal closure without running a model.

import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type DispatchProcess } from "../lib/dispatch-runtime.ts";
import { journalAppend } from "../lib/agent-task-journal.ts";

function fakeChild() {
	const child = new EventEmitter() as EventEmitter & {
		stdout: PassThrough;
		stderr: PassThrough;
		pid: number;
	};
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.pid = 4242;
	return child;
}

describe("shared dispatch runtime", () => {
	it("runs a fake child and closes its journal row", async () => {
		const child = fakeChild();
		const dir = mkdtempSync(join(tmpdir(), "dispatch-runtime-"));
		journalAppend(dir, {
			version: 1, id: "runtime-1", kind: "team", agent: "tester", task: "task",
			status: "dispatched", startedAt: Date.now(), updatedAt: Date.now(),
		});
		const lines: string[] = [];
		const errors: string[] = [];
		let captured: DispatchProcess | undefined;
		const promise = run({
			command: ["pi", "--mode", "json", "task"],
			cwd: dir,
			launchDir: dir,
			launchId: "runtime-1",
			transport: "headless",
			journal: { dir, id: "runtime-1" },
			spawnProcess: (() => child) as any,
			onProcess: (process) => { captured = process; },
			onStdoutLine: (line) => lines.push(line),
			onStderr: (chunk) => errors.push(chunk),
		});

		child.stdout.write('{"type":"message_update"}\npartial');
		child.stderr.write("warning");
		child.stdout.end(" line\n");
		child.stderr.end();
		child.emit("close", 0);

		await expect(promise).resolves.toMatchObject({ exitCode: 0, transport: "headless" });
		expect(lines).toEqual(['{"type":"message_update"}', "partial line"]);
		expect(errors).toEqual(["warning"]);
		expect(captured).toBe(child);
		const journal = readFileSync(join(dir, "task-journal.jsonl"), "utf8");
		expect(journal).toContain('"status":"done"');
		expect(journal).toContain('"pid":4242');
	});

	it("does not start a second transport when a headless child exits with an error", async () => {
		const child = fakeChild();
		let starts = 0;
		const promise = run({
			command: ["pi", "task"],
			cwd: "/tmp",
			launchDir: "/tmp",
			launchId: "runtime-error",
			transport: "headless",
			spawnProcess: (() => { starts++; return child; }) as any,
		});
		child.emit("close", 7);
		await expect(promise).resolves.toMatchObject({ exitCode: 7, transport: "headless" });
		expect(starts).toBe(1);
	});
});
