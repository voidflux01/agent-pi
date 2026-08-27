// ABOUTME: Capability-token authentication for loopback viewer HTTP servers.
// ABOUTME: Prevents hostile local web pages from reading data or triggering mutations.

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface LocalServerAuth {
	token: string;
	cookie: string;
}

/** Create a per-server capability token. It is never persisted. */
export function createLocalServerAuth(): LocalServerAuth {
	const token = randomBytes(32).toString("hex");
	return {
		token,
		cookie: `pi_viewer_token=${token}; Path=/; HttpOnly; SameSite=Strict`,
	};
}

function cookieValue(header: string | undefined): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const [name, ...value] = part.trim().split("=");
		if (name === "pi_viewer_token") return value.join("=");
	}
	return undefined;
}

function tokenMatches(expected: string, candidate: string | null | undefined): boolean {
	if (!candidate) return false;
	const actual = Buffer.from(candidate);
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/**
 * Authorize a request. The initial URL carries the token and is exchanged for
 * an HttpOnly cookie via a clean redirect; later requests use that cookie.
 */
export function authorizeLocalServerRequest(
	req: IncomingMessage,
	res: ServerResponse,
	auth: LocalServerAuth,
	url: URL,
): boolean {
	const contentLength = Number(req.headers["content-length"] || 0);
	if (!Number.isFinite(contentLength) || contentLength > 8 * 1024 * 1024) {
		res.writeHead(413, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
		res.end("Request body too large");
		return false;
	}
	const origin = req.headers.origin;
	if (origin) {
		try {
			const originUrl = new URL(origin);
			const requestHost = String(req.headers.host || "").toLowerCase();
			if (originUrl.protocol !== "http:" || !requestHost || originUrl.host.toLowerCase() !== requestHost) {
				res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
				res.end("Cross-origin request denied");
				return false;
			}
		} catch {
			res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
			res.end("Cross-origin request denied");
			return false;
		}
	}
	if (typeof req.setTimeout === "function") req.setTimeout(15_000, () => req.destroy());
	let received = 0;
	if (typeof req.on === "function") req.on("data", (chunk: Buffer | string) => {
		received += Buffer.byteLength(chunk);
		if (received > 8 * 1024 * 1024) req.destroy();
	});

	const queryToken = url.searchParams.get("token");
	const candidate = queryToken || cookieValue(req.headers.cookie);
	if (!tokenMatches(auth.token, candidate)) {
		res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
		res.end("Unauthorized");
		return false;
	}

	res.setHeader("Cache-Control", "no-store");
	res.setHeader("Referrer-Policy", "no-referrer");
	if (queryToken) {
		// Exchange the one-time URL capability for an HttpOnly cookie, then
		// redirect so the token is not retained in browser history or address bars.
		res.setHeader("Set-Cookie", auth.cookie);
		const cleanUrl = new URL(url.toString());
		cleanUrl.searchParams.delete("token");
		res.setHeader("Location", `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
		res.writeHead(302);
		res.end();
		return false;
	}
	return true;
}
