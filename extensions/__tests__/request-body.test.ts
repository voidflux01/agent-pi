import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { readBoundedRequestBody } from "../lib/request-body.ts";

class FakeRequest extends EventEmitter {
	headers: Record<string, string> = {};
	resume = vi.fn();
}

function fakeResponse() {
	return {
		headersSent: false,
		writeHead: vi.fn(),
		end: vi.fn(),
	} as any;
}

describe("bounded request bodies", () => {
	it("rejects a body that declares more bytes than allowed", () => {
		const req = new FakeRequest();
		req.headers["content-length"] = "11";
		const res = fakeResponse();
		const onBody = vi.fn();

		readBoundedRequestBody(req as any, res, onBody, 10);

		expect(res.writeHead).toHaveBeenCalledWith(413, { "Content-Type": "application/json" });
		expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: "Request body too large" }));
		expect(req.resume).toHaveBeenCalledOnce();
		expect(onBody).not.toHaveBeenCalled();
	});

	it("rejects a streamed body after it crosses the byte limit", () => {
		const req = new FakeRequest();
		const res = fakeResponse();
		const onBody = vi.fn();

		readBoundedRequestBody(req as any, res, onBody, 5);
		req.emit("data", Buffer.from("123456"));
		req.emit("end");

		expect(res.writeHead).toHaveBeenCalledWith(413, { "Content-Type": "application/json" });
		expect(req.resume).toHaveBeenCalledOnce();
		expect(onBody).not.toHaveBeenCalled();
	});

	it("reads a body within the byte limit", () => {
		const req = new FakeRequest();
		req.headers["content-length"] = "5";
		const res = fakeResponse();
		const onBody = vi.fn();

		readBoundedRequestBody(req as any, res, onBody, 5);
		req.emit("data", Buffer.from("hello"));
		req.emit("end");

		expect(onBody).toHaveBeenCalledWith("hello");
		expect(res.writeHead).not.toHaveBeenCalled();
	});
});
