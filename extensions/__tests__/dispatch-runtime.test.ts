// ABOUTME: Contract tests for the shared standard Pi dispatch runtime.
// ABOUTME: A fake child proves stdout, stderr, cancellation boundaries, and journal closure without running a model.

import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentDispatchAuthorization, DEFAULT_ABORT_POLL_INTERVAL_MS, DEFAULT_POLL_TIMEOUT_MS, run, type DispatchProcess, explicitDispatchHandler, withSessionLifecycle } from "../lib/dispatch-runtime.ts";
import { journalAppend } from "../lib/agent-task-journal.ts";

function fakeChild() {
	const child = new EventEmitter() as EventEmitter & {
		stdout: PassThrough;
		stderr: PassThrough;
		pid: number;
		kill: (signal?: NodeJS.Signals | number) => boolean;
	};
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.pid = 4242;
	child.kill = () => {
		child.emit("close", 1);
		return true;
	};
	return child;
}

function runExplicit<T>(origin: "agent-team", operation: () => T): T {
	return explicitDispatchHandler(origin, operation)();
}

describe("shared dispatch runtime", () => {
	it("defaults the worker wait to two hours", () => {
		expect(DEFAULT_POLL_TIMEOUT_MS).toBe(2 * 60 * 60 * 1000);
	});

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
		const promise = runExplicit("agent-team", () => run({
			authorization: currentDispatchAuthorization(),
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
		}));

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

	it("kills a headless worker that exceeds pollTimeoutMs", async () => {
		const child = fakeChild();
		let killed = false;
		child.kill = () => {
			killed = true;
			child.emit("close", 1);
			return true;
		};
		const dir = mkdtempSync(join(tmpdir(), "dispatch-timeout-"));
		journalAppend(dir, {
			version: 1, id: "timeout-1", kind: "team", agent: "builder", task: "task",
			status: "dispatched", startedAt: Date.now(), updatedAt: Date.now(),
		});
		const result = await runExplicit("agent-team", () => run({
			authorization: currentDispatchAuthorization(),
			command: ["pi", "--mode", "json", "task"],
			cwd: dir,
			launchDir: dir,
			launchId: "timeout-1",
			transport: "headless",
			pollTimeoutMs: 20,
			journal: { dir, id: "timeout-1" },
			spawnProcess: (() => child) as any,
		}));
		expect(killed).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.failure).toBe("timeout");
		expect(result.stderr).toContain("Timed out after 20ms");
	});

	it("kills a headless worker when the dispatch is aborted", async () => {
		const child = fakeChild();
		let killed = false;
		child.kill = () => {
			killed = true;
			child.emit("close", 1);
			return true;
		};
		let aborted = false;
		const dir = mkdtempSync(join(tmpdir(), "dispatch-abort-"));
		journalAppend(dir, {
			version: 1, id: "abort-1", kind: "team", agent: "builder", task: "task",
			status: "dispatched", startedAt: Date.now(), updatedAt: Date.now(),
		});
		const resultPromise = runExplicit("agent-team", () => run({
			authorization: currentDispatchAuthorization(),
			command: ["pi", "task"],
			cwd: "/tmp",
			launchDir: "/tmp",
			launchId: "abort-1",
			transport: "headless",
			pollTimeoutMs: 1_000,
			isAborted: () => aborted,
			journal: { dir, id: "abort-1" },
			spawnProcess: (() => child) as any,
		}));
		aborted = true;
		const result = await resultPromise;
		expect(killed).toBe(true);
		expect(result.exitCode).toBe(130);
		expect(result.failure).toBe("aborted");
		expect(readFileSync(join(dir, "task-journal.jsonl"), "utf8")).toContain('"runStatus":"cancelled"');
		expect(DEFAULT_ABORT_POLL_INTERVAL_MS).toBeLessThan(1_000);
	});

	it("does not spawn when already aborted", async () => {
		let starts = 0;
		const result = await runExplicit("agent-team", () => run({
			authorization: currentDispatchAuthorization(),
			command: ["pi", "task"],
			cwd: "/tmp",
			launchDir: "/tmp",
			launchId: "abort-before-start",
			transport: "headless",
			isAborted: () => true,
			spawnProcess: (() => { starts += 1; return fakeChild(); }) as any,
		}));
		expect(result.exitCode).toBe(130);
		expect(result.failure).toBe("aborted");
		expect(starts).toBe(0);
	});

	it("records synchronous spawn failures instead of rejecting", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dispatch-spawn-error-"));
		journalAppend(dir, {
			version: 1, id: "spawn-error-1", kind: "team", agent: "builder", task: "task",
			status: "dispatched", startedAt: Date.now(), updatedAt: Date.now(),
		});
		const result = await runExplicit("agent-team", () => run({
			authorization: currentDispatchAuthorization(),
			command: ["pi", "task"],
			cwd: "/tmp",
			launchDir: "/tmp",
			launchId: "spawn-error-1",
			transport: "headless",
			journal: { dir, id: "spawn-error-1" },
			spawnProcess: (() => { throw new Error("spawn denied"); }) as any,
		}));
		expect(result.failure).toBe("process_error");
		expect(result.stderr).toBe("spawn denied");
		expect(readFileSync(join(dir, "task-journal.jsonl"), "utf8")).toContain('"status":"error"');
	});

	it("classifies asynchronous child errors as process failures", async () => {
		const child = fakeChild();
		const resultPromise = runExplicit("agent-team", () => run({
			authorization: currentDispatchAuthorization(),
			command: ["pi", "task"],
			cwd: "/tmp",
			launchDir: "/tmp",
			launchId: "async-error-1",
			transport: "headless",
			spawnProcess: (() => child) as any,
		}));
		child.emit("error", new Error("worker unavailable"));
		await expect(resultPromise).resolves.toMatchObject({ failure: "process_error", stderr: "worker unavailable" });
	});

	it("refuses a dispatch without explicit authorization before spawning anything", async () => {
		let starts = 0;
		const errors: string[] = [];
		const result = await run({
			command: ["pi", "unexpected"],
			cwd: "/tmp",
			launchDir: "/tmp",
			launchId: "unauthorized",
			transport: "headless",
			spawnProcess: (() => { starts++; return fakeChild(); }) as any,
			onStderr: (message) => errors.push(message),
		} as any);

		expect(result.exitCode).toBe(126);
		expect(result.stderr).toContain("explicit tool or command authorization");
		expect(errors.join(" ")).toContain("explicit tool or command authorization");
		expect(starts).toBe(0);
	});

	it("refuses a timer callback even when it inherits an explicit context", async () => {
		const result = await runExplicit("agent-team", () => new Promise<any>((resolve) => {
			setTimeout(async () => {
				resolve(await run({
					command: ["pi", "deferred"],
					cwd: "/tmp",
					launchDir: "/tmp",
					launchId: "timer-dispatch",
					transport: "headless",
					authorization: currentDispatchAuthorization(),
					spawnProcess: (() => { throw new Error("must not spawn"); }) as any,
				}));
			}, 0);
		}));

		expect(result.exitCode).toBe(126);
		expect(result.stderr).toContain("explicit tool or command authorization");
	});

	it("cannot reopen dispatch from a timer callback", async () => {
		let starts = 0;
		const result = await runExplicit("agent-team", () => new Promise<any>((resolve) => {
			setTimeout(() => resolve(runExplicit("agent-team", () => run({
				command: ["pi", "nested-timer"],
				cwd: "/tmp",
				launchDir: "/tmp",
				launchId: "nested-timer",
				transport: "headless",
				authorization: currentDispatchAuthorization(),
				spawnProcess: (() => { starts++; return fakeChild(); }) as any,
			}))), 0);
		}));

		expect(result.exitCode).toBe(126);
		expect(result.stderr).toContain("explicit tool or command authorization");
		expect(starts).toBe(0);
	});

	it("cannot leak dispatch through fire-and-forget lifecycle work", async () => {
		let starts = 0;
		const result = await new Promise<any>((resolve) => {
			withSessionLifecycle(() => {
				runExplicit("agent-team", () => {
					queueMicrotask(() => resolve(run({
						command: ["pi", "lifecycle-deferred"],
						cwd: "/tmp",
						launchDir: "/tmp",
						launchId: "lifecycle-deferred",
						transport: "headless",
						authorization: currentDispatchAuthorization(),
						spawnProcess: (() => { starts++; return fakeChild(); }) as any,
					})));
				});
			});
		});

		expect(result.exitCode).toBe(126);
		expect(result.stderr).toContain("explicit tool or command authorization");
		expect(starts).toBe(0);
	});

	it("keeps authorization across await inside the explicit context", async () => {
		const child = fakeChild();
		const promise = runExplicit("agent-team", async () => {
			await Promise.resolve();
			const running = run({
				authorization: currentDispatchAuthorization(),
				command: ["pi", "task"],
				cwd: "/tmp",
				launchDir: "/tmp",
				launchId: "after-await",
				transport: "headless",
				spawnProcess: (() => child) as any,
			});
			child.emit("close", 0);
			return running;
		});
		await expect(promise).resolves.toMatchObject({ exitCode: 0, transport: "headless" });
	});

	it("refuses dispatch during session lifecycle even with an explicit context", async () => {
		let starts = 0;
		const result = await withSessionLifecycle(() =>
			runExplicit("agent-team", () => run({
				authorization: currentDispatchAuthorization(),
				command: ["pi", "lifecycle"],
				cwd: "/tmp",
				launchDir: "/tmp",
				launchId: "session-lifecycle",
				transport: "headless",
				spawnProcess: (() => { starts++; return fakeChild(); }) as any,
			})),
		);
		expect(result.exitCode).toBe(126);
		expect(result.stderr).toContain("explicit tool or command authorization");
		expect(starts).toBe(0);
	});

	it("does not start a second transport when a headless child exits with an error", async () => {
		const child = fakeChild();
		let starts = 0;
		const promise = runExplicit("agent-team", () => run({
			authorization: currentDispatchAuthorization(),
			command: ["pi", "task"],
			cwd: "/tmp",
			launchDir: "/tmp",
			launchId: "runtime-error",
			transport: "headless",
			spawnProcess: (() => { starts++; return child; }) as any,
		}));
		child.emit("close", 7);
		await expect(promise).resolves.toMatchObject({ exitCode: 7, transport: "headless" });
		expect(starts).toBe(1);
	});
});
