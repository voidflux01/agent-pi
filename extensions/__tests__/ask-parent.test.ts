import { describe, expect, test } from "bun:test";
import { fileAskAndWait, answerAsk, listAsks, asksDir, type AskRecord } from "../ask-parent.ts";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("ask_parent mailbox", () => {
	test("open ask is visible via listAsks and answered by id", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "ask-parent-e2e-"));
		const waiter = fileAskAndWait("Which database should I pick?", {
			agent: "builder",
			options: ["postgres", "sqlite"],
			timeoutMs: 15_000,
			cwd,
		});
		// wait for the ask file to appear
		let rec: AskRecord | null = null;
		for (let i = 0; i < 100 && !rec; i++) {
			await new Promise((r) => setTimeout(r, 100));
			rec = listAsks("open", cwd)[0] ?? null;
		}
		expect(rec).not.toBeNull();
		expect(rec!.agent).toBe("builder");
		expect(rec!.question).toContain("database");

		expect(answerAsk(rec!.id, "use sqlite - it ships with node", cwd)).toBe(true);
		const res = await waiter;
		expect(res.answered).toBe(true);
		expect(res.answer).toContain("sqlite");
		expect(listAsks("open", cwd)).toHaveLength(0);
	}, 30_000);

	test("timeout expires the ask with answered=false", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "ask-parent-e2e-"));
		const res = await fileAskAndWait("nobody home", { agent: "scout", timeoutMs: 1500, cwd });
		expect(res.answered).toBe(false);
		const expired = listAsks("expired", cwd);
		expect(expired.length).toBe(1);
	}, 20_000);
});
