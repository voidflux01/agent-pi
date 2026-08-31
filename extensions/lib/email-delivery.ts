// ABOUTME: Local delivery receipts for external email side effects.
// ABOUTME: Stores metadata only; message bodies and credentials never enter the receipt.

import { appendFileSync, existsSync, readFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

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
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, JSON.stringify(receipt) + "\n", "utf8");
	} catch {
		// A receipt must never prevent the external operation itself. The returned
		// ID still correlates the provider result in the current tool response.
	}
	return receipt;
}

export function finishEmailDelivery(cwd: string, id: string, status: Exclude<EmailDeliveryStatus, "pending">, error?: string): EmailDeliveryReceipt | undefined {
	const path = receiptPath(cwd);
	if (!existsSync(path)) return undefined;
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
	try {
		const tmp = `${path}.tmp-${process.pid}`;
		writeFileSync(tmp, next.join("\n") + "\n", "utf8");
		renameSync(tmp, path);
	} catch { return found; }
	return found;
}

export function listEmailDeliveries(cwd: string): EmailDeliveryReceipt[] {
	try {
		return readFileSync(receiptPath(cwd), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as EmailDeliveryReceipt).slice(-50).reverse();
	} catch { return []; }
}
