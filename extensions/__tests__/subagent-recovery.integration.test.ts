import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentDispatchAuthorization, explicitDispatchHandler, run } from "../lib/dispatch-runtime.ts";
import { createOrchestrationRun } from "../lib/orchestration-run.ts";
import { journalAppend } from "../lib/agent-task-journal.ts";
import { listRunEvents } from "../lib/evidence-store.ts";
import { withSessionResume } from "../lib/subagent-recovery.ts";

function fakeChild() {
	const child = new EventEmitter() as EventEmitter & {
		stdout: PassThrough;
		stderr: PassThrough;
		pid: number;
		kill: () => boolean;
	};
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.pid = 7411;
	child.kill = () => { child.emit("close", 1); return true; };
	return child;
}

describe("standalone subagent recovery integration", () => {
	for (const mode of ["NORMAL", "PLAN", "SPEC"]) {
		it(`reopens a persisted session and preserves ${mode} parent topology`, async () => {
			const cwd = mkdtempSync(join(tmpdir(), `pi-${mode.toLowerCase()}-resume-`));
			const sessionDir = join(cwd, ".pi", "agent-sessions");
			const sessionFile = join(cwd, "subagent.jsonl");
			writeFileSync(sessionFile, "existing session\n");
			const dispatchId = `${mode.toLowerCase()}-builder-sa1-resume`;
			journalAppend(sessionDir, {
				version: 1, id: dispatchId, kind: "sa", agent: "builder", task: "original task",
				status: "done", sessionFile, startedAt: Date.now() - 1000, updatedAt: Date.now() - 500,
			});
			const parent = createOrchestrationRun({
				eventDir: join(cwd, "parent-events"), actor: `subagent:${mode.toLowerCase()}`,
				mode, budget: { maxSteps: 1 },
			});
			const child = fakeChild();
			let captured: string[] = [];
			const command = withSessionResume(["pi", "--session", sessionFile, "continue task"], sessionFile);
			const resultPromise = explicitDispatchHandler("subagent-resume", () => run({
				authorization: currentDispatchAuthorization(), command, cwd,
				launchDir: sessionDir, launchId: dispatchId, sessionFile,
				parentRunId: parent.runId, transport: "headless",
				journal: { dir: sessionDir, id: dispatchId },
				spawnProcess: ((executable: string, args: string[]) => {
					captured = [executable, ...args];
					queueMicrotask(() => {
						child.stdout.end('{"type":"message_update"}\n');
						child.emit("close", 0);
					});
					return child;
				}) as any,
			}))();
			const result = await resultPromise;
			parent.finish("succeeded");

			expect(result.exitCode).toBe(0);
			expect(captured).toContain("-c");
			expect(captured[captured.length - 1]).toBe("continue task");
			expect(readFileSync(join(sessionDir, "task-journal.jsonl"), "utf8")).toContain('"status":"done"');
			const events = listRunEvents(join(cwd, "compositions", result.runId!));
			expect(events[0]?.payload).toMatchObject({ data: { parentRunId: parent.runId } });
			expect(events.map(event => event.type)).toContain("run.succeeded");
		});
	}
});
