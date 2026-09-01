// ABOUTME: Shared bounded HTTP request-body reader for local viewers.
// ABOUTME: Enforces declared and streamed byte limits while draining rejected requests.

import type { IncomingMessage, ServerResponse } from "node:http";

export function readBoundedRequestBody(
	req: IncomingMessage,
	res: ServerResponse,
	onBody: (body: string) => void,
	maxBytes: number,
	errorBody: Record<string, unknown> = { error: "Request body too large" },
	unreadableBody: Record<string, unknown> = { error: "Request body unreadable" },
): void {
	const declared = Number(req.headers["content-length"] || 0);
	const rejectTooLarge = () => {
		if (!res.headersSent) {
			res.writeHead(413, { "Content-Type": "application/json" });
			res.end(JSON.stringify(errorBody));
		}
		req.resume();
	};

	if (!Number.isFinite(declared) || declared < 0 || declared > maxBytes) {
		rejectTooLarge();
		return;
	}

	let body = "";
	let received = 0;
	let rejected = false;
	req.on("data", (chunk) => {
		if (rejected) return;
		received += Buffer.byteLength(chunk);
		if (received > maxBytes) {
			rejected = true;
			rejectTooLarge();
			return;
		}
		body += chunk;
	});
	req.on("end", () => { if (!rejected) onBody(body); });
	req.on("error", () => {
		if (!rejected && !res.headersSent) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify(unreadableBody));
		}
	});
}
