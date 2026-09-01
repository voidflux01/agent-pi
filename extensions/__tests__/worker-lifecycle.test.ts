import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createWorkerLifecycle } from "../lib/worker-lifecycle.ts";

describe("worker lifecycle", () => {
	it("invalidates old epochs and stops tracked resources", () => {
		const lifecycle = createWorkerLifecycle();
		const timer = setInterval(() => {}, 60_000);
		const child = { kill: vi.fn() };
		const epoch = lifecycle.currentEpoch();
		lifecycle.trackTimer(timer);
		lifecycle.trackProcess(child);

		expect(lifecycle.isCurrent(epoch)).toBe(true);
		lifecycle.stopAll();
		expect(lifecycle.isCurrent(epoch)).toBe(false);
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		clearInterval(timer);
	});

	it("releases individual handles without invalidating the epoch", () => {
		const lifecycle = createWorkerLifecycle();
		const timer = setInterval(() => {}, 60_000);
		const child = { kill: vi.fn() };
		const epoch = lifecycle.currentEpoch();
		lifecycle.trackTimer(timer);
		lifecycle.trackProcess(child);
		lifecycle.clearTimer(timer);
		lifecycle.clearProcess(child);

		expect(lifecycle.isCurrent(epoch)).toBe(true);
		lifecycle.stopAll();
		expect(child.kill).not.toHaveBeenCalled();
	});

	it("terminates a real worker process at the lifecycle boundary", async () => {
		const lifecycle = createWorkerLifecycle();
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
		lifecycle.trackProcess(child);

		const exited = new Promise<number | null>((resolve) => {
			child.once("exit", (code) => resolve(code));
		});
		lifecycle.stopAll();

		expect(await exited).not.toBe(0);
	});
});
