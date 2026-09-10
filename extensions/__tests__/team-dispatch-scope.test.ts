// ABOUTME: TEAM mode must dispatch any loaded specialist, not only roster members.

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import agentTeam from "../agent-team.ts";
import { workflowDispatchBefore } from "../lib/workflow-dispatch.ts";
import { setCoordinationMode } from "../lib/coordination-state.ts";

type Handler = (event: any, ctx: any) => any;

function loadTeamExtension(cwd: string) {
	const handlers = new Map<string, Handler[]>();
	const statuses: string[] = [];
	const ui = {
		notify() { }, setStatus(_key: string, value: string) { statuses.push(value); }, setWidget() { },
		setTheme: () => ({ success: true }), getTheme: () => "midnight-ocean",
	};
	const pi: any = new Proxy({
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	}, {
		get: (target: any, prop: string) => prop in target ? target[prop] : () => { },
	});

	agentTeam(pi);
	return {
		statuses,
		async start(ctx: any = { cwd, ui, hasUI: true, model: { contextWindow: 100000 } }) {
			for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
		},
		async systemPrompt(ctx: any = { cwd, ui, hasUI: true, model: { contextWindow: 100000 } }) {
			const handler = (handlers.get("before_agent_start") ?? []).at(-1);
			return (await handler?.({}, ctx))?.systemPrompt ?? "";
		},
	};
}

describe("TEAM dispatch scope", () => {
	it("dispatches a non-roster specialist after the default roster is active", async () => {
		const ext = loadTeamExtension(mkdtempSync(join(tmpdir(), "team-scope-")));
		await ext.start();
		expect(ext.statuses.at(-1)).toBe("Team: plan-build (4)");

		for (const name of ["researcher", "scout", "planner", "builder", "reviewer"]) {
			expect(workflowDispatchBefore("TEAM", { name, task: "inspect the repository", batch: false })).toBeUndefined();
		}
	});

	it("tells the TEAM coordinator that off-roster specialists are dispatchable", async () => {
		const ext = loadTeamExtension(mkdtempSync(join(tmpdir(), "team-scope-")));
		await ext.start();
		setCoordinationMode("TEAM");

		const prompt = await ext.systemPrompt();
		expect(prompt).toContain("Dispatch is not restricted");
		expect(prompt).toContain("researcher");
		expect(prompt).not.toContain("You can dispatch only to the agents listed below.");
	});
});
