// ABOUTME: Local delivery receipts for external email side effects.
// ABOUTME: Stores metadata only; message bodies and credentials never enter the receipt.

import { appendFileSync, closeSync, existsSync, readFileSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const RECEIPT_LOCK_ATTEMPTS = 50;
const RECEIPT_LOCK_WAIT_MS = 20;
const OWNERLESS_LOCK_STALE_MS = 5_000;

function sleep(ms: number): void {
	try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

function processIsAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Serialize receipt mutations across concurrently running Pi processes. */
function withReceiptLock<T>(path: string, action: () => T): T | undefined {
	const lock = `${path}.lock`;
	let fd: number | undefined;
	try {
		mkdirSync(dirname(path), { recursive: true });
		for (let attempt = 0; attempt < RECEIPT_LOCK_ATTEMPTS; attempt++) {
			try {
				fd = openSync(lock, "wx");
				writeFileSync(lock, `${process.pid}\n`, "utf8");
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
				let owner: number | undefined;
				try { owner = Number.parseInt(readFileSync(lock, "utf8").trim(), 10); } catch {}
				let stale = false;
				try { stale = owner !== undefined && Number.isFinite(owner) && owner > 0 ? !processIsAlive(owner) : Date.now() - statSync(lock).mtimeMs > OWNERLESS_LOCK_STALE_MS; } catch { stale = false; }
				if (stale) { try { unlinkSync(lock); } catch {} }
				else sleep(RECEIPT_LOCK_WAIT_MS);
			}
		}
		if (fd === undefined) return undefined;
		return action();
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) { try { closeSync(fd); } catch {} }
		if (fd !== undefined) { try { unlinkSync(lock); } catch {} }
	}
}

export type EmailDeliveryStatus = "pending" | "submitted" | "failed";

export interface EmailDeliveryReceipt {
	version: 1;
	id: string;
	status: EmailDeliveryStatus;
	type: string;
	to?: string;
	subject?: string;
	createdAt: string;
	updatedAt: string;
	error?: string;
}

function receiptPath(cwd: string): string {
	return join(cwd, ".pi", "agent-sessions", "email-deliveries.jsonl");
}

export function beginEmailDelivery(cwd: string, input: Pick<EmailDeliveryReceipt, "type" | "to" | "subject">): EmailDeliveryReceipt {
	const now = new Date().toISOString();
	const receipt: EmailDeliveryReceipt = { version: 1, id: randomUUID(), status: "pending", ...input, createdAt: now, updatedAt: now };
	const path = receiptPath(cwd);
	withReceiptLock(path, () => {
		appendFileSync(path, JSON.stringify(receipt) + "\n", "utf8");
		return true;
	});
	// A receipt must never prevent the external operation itself. The returned
	// ID still correlates the provider result in the current tool response.
	return receipt;
}

export function finishEmailDelivery(cwd: string, id: string, status: Exclude<EmailDeliveryStatus, "pending">, error?: string): EmailDeliveryReceipt | undefined {
	const path = receiptPath(cwd);
	if (!existsSync(path)) return undefined;
	return withReceiptLock(path, () => {
		let lines: string[];
		try { lines = readFileSync(path, "utf8").split("\n").filter(Boolean); } catch { return undefined; }
		let found: EmailDeliveryReceipt | undefined;
		const next = lines.map((line) => {
			try {
				const receipt = JSON.parse(line) as EmailDeliveryReceipt;
				if (receipt.id !== id) return line;
				found = { ...receipt, status, updatedAt: new Date().toISOString(), ...(error ? { error: error.slice(0, 500) } : {}) };
				return JSON.stringify(found);
			} catch { return line; }
		});
		if (!found) return undefined;
		const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
		try {
			writeFileSync(tmp, next.join("\n") + "\n", "utf8");
			renameSync(tmp, path);
		} catch {
			try { unlinkSync(tmp); } catch {}
			return found;
		}
		return found;
	});
}

export function listEmailDeliveries(cwd: string): EmailDeliveryReceipt[] {
	try {
		return readFileSync(receiptPath(cwd), "utf8").split("\n").filter(Boolean).flatMap((line) => {
			try { return [JSON.parse(line) as EmailDeliveryReceipt]; } catch { return []; }
		}).slice(-50).reverse();
	} catch { return []; }
}
