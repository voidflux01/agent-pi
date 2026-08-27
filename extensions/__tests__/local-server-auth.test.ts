import { describe, expect, it } from "bun:test";
import { authorizeLocalServerRequest, createLocalServerAuth } from "../lib/local-server-auth.ts";

function response() {
	return { headers: new Map<string, string>(), status: 0, setHeader(name: string, value: string) { this.headers.set(name, value); }, writeHead(status: number) { this.status = status; }, end() {} } as any;
}

function request(origin?: string) {
	return { headers: { host: "127.0.0.1:4321", cookie: "pi_viewer_token=valid" , ...(origin ? { origin } : {}) }, socket: { remoteAddress: "127.0.0.1" }, on() {}, setTimeout() {} } as any;
}

describe("local viewer origin boundary", () => {
	it("rejects same-site but cross-origin loopback requests", () => {
		const auth = { token: "valid", cookie: "pi_viewer_token=valid" };
		const res = response();
		expect(authorizeLocalServerRequest(request("http://127.0.0.1:9999"), res, auth, new URL("http://127.0.0.1:4321/save"))).toBe(false);
		expect(res.status).toBe(403);
	});

	it("accepts the viewer's own origin with the capability cookie", () => {
		const auth = createLocalServerAuth();
		const req = request("http://127.0.0.1:4321");
		req.headers.cookie = auth.cookie.split(";")[0];
		expect(authorizeLocalServerRequest(req, response(), auth, new URL("http://127.0.0.1:4321/save"))).toBe(true);
	});
});
