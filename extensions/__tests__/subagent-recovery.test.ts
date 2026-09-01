import { describe, expect, it } from "vitest";
import { withSessionResume } from "../lib/subagent-recovery.ts";

describe("standalone subagent recovery", () => {
	it("adds -c immediately before the follow-up prompt for an existing session", () => {
		const argv = ["pi", "--session", "/safe/session.jsonl", "follow up"];
		expect(withSessionResume(argv, "/safe/session.jsonl", () => true)).toEqual([
			"pi", "--session", "/safe/session.jsonl", "-c", "follow up",
		]);
	});

	it("leaves a new session command unchanged", () => {
		const argv = ["pi", "--session", "/safe/new.jsonl", "first task"];
		expect(withSessionResume(argv, "/safe/new.jsonl", () => false)).toEqual(argv);
	});
});
