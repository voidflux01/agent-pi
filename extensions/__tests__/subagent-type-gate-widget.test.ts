// ABOUTME: Widget-level integration test for per-type dispatch exclusivity.
// ABOUTME: Two concurrent same-type subagent_create calls must yield exactly one
// ABOUTME: spawned SA and one pointer response through the registered tool executor.

import { describe, expect, it, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import * as actualChildProcess from "node:child_process";

const fakeProc = () => {
	const proc: any = new EventEmitter();
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.pid = 4242;
	proc.kill = () => true;
	return proc;
};

// Stub child_process.spawn so the widget never launches a real worker process.
mock.module("node:child_process", () => ({
	...actualChildProcess,
	spawn: () => fakeProc(),
	spawnSync: actualChildProcess.spawnSync,
}));

const { default: subagentWidget } = await import("../subagent-widget.ts");

function makePi() {
	const tools: any[] = [];
	return {
		pi: {
			registerTool(def: any) { tools.push(def); },
			registerCommand() {},
			registerShortcut() {},
			getAllTools() { return []; },
			on() {},
		} as any,
		tools,
	};
}

describe("subagent type exclusivity through the widget tool executor", () => {
	it("yields exactly one spawned SA and one pointer response for concurrent same-type creates", async () => {
		const { pi, tools } = makePi();
		subagentWidget(pi);
		const create = tools.find((t) => t.name === "subagent_create");
		expect(create).toBeDefined();

		const ctx = { cwd: mkdtempSync(join(tmpdir(), "sa-gate-")), ui: { setWidget() {}, notify() {} } };
		const call = (callId: string) => create.execute(callId, { name: "BUILDER", task: "do work", join: false }, undefined, undefined, ctx);
		const [first, second] = await Promise.all([call("c1"), call("c2")]);

		const spawnedResults = [first, second].filter((r) => r?.details?.id);
		const pointers = [first, second].filter((r) => r?.details?.deduped === true && r?.details?.dedupAxis === "type");
		expect(spawnedResults.length).toBe(1);
		expect(pointers.length).toBe(1);
		expect(pointers[0].details.existingId).toBe(spawnedResults[0].details.id);
		expect(pointers[0].content[0].text).toContain("of the same type is already running");
	});
});
