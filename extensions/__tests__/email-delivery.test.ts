import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginEmailDelivery, finishEmailDelivery, listEmailDeliveries } from "../lib/email-delivery.ts";

describe("email delivery receipts", () => {
	it("tracks provider submission without storing message content", () => {
		const cwd = mkdtempSync(join(tmpdir(), "email-delivery-"));
		try {
			const pending = beginEmailDelivery(cwd, { type: "report", to: "user@example.com", subject: "Build" });
			expect(pending.status).toBe("pending");
			const submitted = finishEmailDelivery(cwd, pending.id, "submitted");
			expect(submitted?.status).toBe("submitted");
			expect(listEmailDeliveries(cwd)).toMatchObject([{ id: pending.id, status: "submitted", subject: "Build" }]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("records a provider failure for later inspection", () => {
		const cwd = mkdtempSync(join(tmpdir(), "email-delivery-"));
		try {
			const pending = beginEmailDelivery(cwd, { type: "generic" });
			finishEmailDelivery(cwd, pending.id, "failed", "timeout");
			expect(listEmailDeliveries(cwd)[0]).toMatchObject({ id: pending.id, status: "failed", error: "timeout" });
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("skips malformed receipt lines without hiding valid history", () => {
		const cwd = mkdtempSync(join(tmpdir(), "email-delivery-"));
		try {
			const pending = beginEmailDelivery(cwd, { type: "report" });
			const path = join(cwd, ".pi", "agent-sessions", "email-deliveries.jsonl");
			appendFileSync(path, "not-json\n", "utf8");
			expect(listEmailDeliveries(cwd).map((receipt) => receipt.id)).toEqual([pending.id]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("recovers an abandoned owner-less lock", () => {
		const cwd = mkdtempSync(join(tmpdir(), "email-delivery-"));
		try {
			const dir = join(cwd, ".pi", "agent-sessions");
			const path = join(dir, "email-deliveries.jsonl");
			const lock = `${path}.lock`;
			mkdirSync(dir, { recursive: true });
			writeFileSync(lock, "\n", "utf8");
			const old = new Date(Date.now() - 6_000);
			utimesSync(lock, old, old);
			const pending = beginEmailDelivery(cwd, { type: "report" });
			expect(listEmailDeliveries(cwd).map((receipt) => receipt.id)).toEqual([pending.id]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
