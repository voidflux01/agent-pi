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
	if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > 8 * 1024 * 1024) {
		res.writeHead(413, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
		res.end("Request body too large");
		if (typeof req.resume === "function") req.resume();
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
		res.writeHead(401, {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
		});
		res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Viewer</title></head>
<body style="margin:0;background:#1a1d23;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:48px 24px;line-height:1.5">
<h1 style="font-size:20px;margin:0 0 12px">This viewer did not load</h1>
<p style="color:#8892a0;max-width:36em">The address has no valid token. Pi opens a local link that includes <code>?token=</code>. Open that link from the Pi session, or run the viewer command again. Reloading <code>http://127.0.0.1:…/</code> after the token was stripped will stay empty.</p>
</body></html>`);
		return false;
	}

	res.setHeader("Cache-Control", "no-store");
	res.setHeader("Referrer-Policy", "no-referrer");
	if (queryToken) {
		// Set the cookie for later POSTs, but serve this request immediately.
		// A 302 to the token-less path races Set-Cookie: Chrome often follows
		// Location before the cookie is stored, so the next GET is 401 and the
		// tab looks empty.
		res.setHeader("Set-Cookie", auth.cookie);
	}
	return true;
}
