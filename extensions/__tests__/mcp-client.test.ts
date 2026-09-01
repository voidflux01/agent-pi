// ABOUTME: Tests for the generic MCP stdio JSON-RPC client library.
// ABOUTME: Covers message formatting, buffer parsing, handshake, tool calls, and error handling.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";

// We'll test the exported functions/class from mcp-client.ts
// Import after mock setup
let McpClient: typeof import("../lib/mcp-client.ts").McpClient;
let formatJsonRpcRequest: typeof import("../lib/mcp-client.ts").formatJsonRpcRequest;
let parseJsonRpcLines: typeof import("../lib/mcp-client.ts").parseJsonRpcLines;

// ── Mock child_process ──────────────────────────────────────────────

function createMockProcess(): ChildProcess & {
	stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
	stdout: EventEmitter;
	stderr: EventEmitter;
} {
	const proc = new EventEmitter() as any;
	proc.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
	proc.stdout = new EventEmitter();
	(proc.stdout as any).setEncoding = vi.fn();
	proc.stderr = new EventEmitter();
	proc.kill = vi.fn();
	proc.pid = 12345;
	return proc;
}

let mockSpawn: ReturnType<typeof vi.fn>;
let lastMockProc: ReturnType<typeof createMockProcess>;

vi.mock("child_process", () => ({
	spawn: (...args: any[]) => {
		lastMockProc = createMockProcess();
		mockSpawn(...args);
		return lastMockProc;
	},
}));

beforeEach(async () => {
	mockSpawn = vi.fn();
	const mod = await import("../lib/mcp-client.ts");
	McpClient = mod.McpClient;
	formatJsonRpcRequest = mod.formatJsonRpcRequest;
	parseJsonRpcLines = mod.parseJsonRpcLines;
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ── JSON-RPC message formatting ─────────────────────────────────────

describe("formatJsonRpcRequest", () => {
	it("should format a JSON-RPC 2.0 request with method and params", () => {
		const msg = formatJsonRpcRequest(1, "tools/call", { name: "test", arguments: {} });
		const parsed = JSON.parse(msg);
		expect(parsed).toEqual({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "test", arguments: {} },
		});
	});

	it("should format a notification (no id) when id is undefined", () => {
		const msg = formatJsonRpcRequest(undefined, "notifications/initialized", {});
		const parsed = JSON.parse(msg);
		expect(parsed.jsonrpc).toBe("2.0");
		expect(parsed.method).toBe("notifications/initialized");
		expect(parsed).not.toHaveProperty("id");
	});

	it("should include incrementing id values", () => {
		const msg1 = formatJsonRpcRequest(1, "test", {});
		const msg2 = formatJsonRpcRequest(2, "test", {});
		expect(JSON.parse(msg1).id).toBe(1);
		expect(JSON.parse(msg2).id).toBe(2);
	});
});

// ── Line-delimited buffer parsing ───────────────────────────────────

describe("parseJsonRpcLines", () => {
	it("should parse a complete JSON-RPC line", () => {
		const line = '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n';
		const { messages, remainder } = parseJsonRpcLines(line);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
		expect(remainder).toBe("");
	});

	it("should handle multiple lines in one chunk", () => {
		const chunk = '{"jsonrpc":"2.0","id":1,"result":"a"}\n{"jsonrpc":"2.0","id":2,"result":"b"}\n';
		const { messages, remainder } = parseJsonRpcLines(chunk);
		expect(messages).toHaveLength(2);
		expect(messages[0].id).toBe(1);
		expect(messages[1].id).toBe(2);
		expect(remainder).toBe("");
	});

	it("should return remainder for partial messages", () => {
		const chunk = '{"jsonrpc":"2.0","id":1,"res';
		const { messages, remainder } = parseJsonRpcLines(chunk);
		expect(messages).toHaveLength(0);
		expect(remainder).toBe('{"jsonrpc":"2.0","id":1,"res');
	});

	it("should handle chunked data across calls", () => {
		const { messages: m1, remainder: r1 } = parseJsonRpcLines('{"jsonrpc":"2.0"');
		expect(m1).toHaveLength(0);

		const { messages: m2, remainder: r2 } = parseJsonRpcLines(r1 + ',"id":1,"result":"ok"}\n');
		expect(m2).toHaveLength(1);
		expect(m2[0].result).toBe("ok");
		expect(r2).toBe("");
	});

	it("should skip non-JSON lines gracefully", () => {
		const chunk = 'some log output\n{"jsonrpc":"2.0","id":1,"result":"ok"}\n';
		const { messages, remainder } = parseJsonRpcLines(chunk);
		expect(messages).toHaveLength(1);
		expect(messages[0].result).toBe("ok");
	});

	it("should handle empty input", () => {
		const { messages, remainder } = parseJsonRpcLines("");
		expect(messages).toHaveLength(0);
		expect(remainder).toBe("");
	});
});

// ── McpClient ───────────────────────────────────────────────────────

describe("McpClient", () => {
	it("should spawn the server process on connect", async () => {
		const client = new McpClient("/path/to/server.js", { FOO: "bar" });

		// Start connect but don't await — we need to simulate the handshake
		const connectPromise = client.connect();

		// Simulate initialize response
		const initResponse = JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } },
		}) + "\n";
		lastMockProc.stdout.emit("data", initResponse);

		await connectPromise;

		expect(mockSpawn).toHaveBeenCalledWith(
			"node",
			["/path/to/server.js"],
			expect.objectContaining({
				stdio: ["pipe", "pipe", "pipe"],
				env: expect.objectContaining({ FOO: "bar" }),
			}),
		);
	});

	it("should share one in-flight connection across concurrent callers", async () => {
		const client = new McpClient("/path/to/server.js", {});
		const first = client.connect();
		const second = client.connect();

		expect(mockSpawn).toHaveBeenCalledTimes(1);
		lastMockProc.stdout.emit("data", JSON.stringify({
			jsonrpc: "2.0", id: 1,
			result: { protocolVersion: "2024-11-05", capabilities: {} },
		}) + "\n");

		await Promise.all([first, second]);
		expect(client.isConnected()).toBe(true);
	});

	it("should ignore delayed events from a previous process after reconnect", async () => {
		const client = new McpClient("/path/to/server.js", {});
		const firstConnect = client.connect();
		const firstProc = lastMockProc;
		firstProc.stdout.emit("data", JSON.stringify({
			jsonrpc: "2.0", id: 1,
			result: { protocolVersion: "2024-11-05", capabilities: {} },
		}) + "\n");
		await firstConnect;

		client.disconnect();
		const reconnect = client.connect();
		const secondProc = lastMockProc;
		secondProc.stdout.emit("data", JSON.stringify({
			jsonrpc: "2.0", id: 2,
			result: { protocolVersion: "2024-11-05", capabilities: {} },
		}) + "\n");
		await reconnect;

		firstProc.emit("close", 1);
		firstProc.emit("error", new Error("stale process"));
		firstProc.stdout.emit("data", '{"jsonrpc":"2.0","id":999}\n');
		expect(client.isConnected()).toBe(true);
	});

	it("should send initialize handshake on connect", async () => {
		const client = new McpClient("/path/to/server.js", {});
		const connectPromise = client.connect();

		// Check that initialize was written to stdin
		expect(lastMockProc.stdin.write).toHaveBeenCalledTimes(1);
		const written = lastMockProc.stdin.write.mock.calls[0][0] as string;
		const parsed = JSON.parse(written.trim());
		expect(parsed.method).toBe("initialize");
		expect(parsed.params).toHaveProperty("protocolVersion");
		expect(parsed.params).toHaveProperty("clientInfo");

		// Simulate response
		lastMockProc.stdout.emit("data", JSON.stringify({
			jsonrpc: "2.0", id: 1,
			result: { protocolVersion: "2024-11-05", capabilities: {} },
		}) + "\n");

		await connectPromise;

		// After init response, should send notifications/initialized
		expect(lastMockProc.stdin.write).toHaveBeenCalledTimes(2);
		const notif = JSON.parse((lastMockProc.stdin.write.mock.calls[1][0] as string).trim());
		expect(notif.method).toBe("notifications/initialized");
		expect(notif).not.toHaveProperty("id");
	});

	it("should proxy tool calls to the MCP server", async () => {
		const client = new McpClient("/path/to/server.js", {});
		const connectPromise = client.connect();

		// Complete handshake
		lastMockProc.stdout.emit("data", JSON.stringify({
			jsonrpc: "2.0", id: 1,
			result: { protocolVersion: "2024-11-05", capabilities: {} },
		}) + "\n");
		await connectPromise;

		// Make a tool call
		const callPromise = client.callTool("commander_task", { operation: "list" });

		// Find the tool call request written to stdin
		const callWritten = lastMockProc.stdin.write.mock.calls[2][0] as string;
		const callParsed = JSON.parse(callWritten.trim());
		expect(callParsed.method).toBe("tools/call");
		expect(callParsed.params).toEqual({ name: "commander_task", arguments: { operation: "list" } });

		// Simulate response
		lastMockProc.stdout.emit("data", JSON.stringify({
			jsonrpc: "2.0", id: callParsed.id,
			result: { content: [{ type: "text", text: "tasks listed" }] },
		}) + "\n");

		const result = await callPromise;
		expect(result).toEqual({ content: [{ type: "text", text: "tasks listed" }] });
	});

	it("should reject tool call on error response", async () => {
		const client = new McpClient("/path/to/server.js", {});
		const connectPromise = client.connect();

		lastMockProc.stdout.emit("data", JSON.stringify({
			jsonrpc: "2.0", id: 1,
			result: { protocolVersion: "2024-11-05", capabilities: {} },
		}) + "\n");
		await connectPromise;

		const callPromise = client.callTool("bad_tool", {});
		const callWritten = lastMockProc.stdin.write.mock.calls[2][0] as string;
		const callParsed = JSON.parse(callWritten.trim());

		// Simulate error response
		lastMockProc.stdout.emit("data", JSON.stringify({
			jsonrpc: "2.0", id: callParsed.id,
			error: { code: -32601, message: "Unknown tool: bad_tool" },
		}) + "\n");

		await expect(callPromise).rejects.toThrow("Unknown tool: bad_tool");
	});

	it("should default to 60s timeout", () => {
		const client = new McpClient("/path/to/server.js", {});
		// Access private field via any cast — fragile but validates the default
		expect((client as any).timeoutMs).toBe(60_000);
	});

	it("should timeout tool calls after configured timeout", async () => {
		vi.useFakeTimers();

		const client = new McpClient("/path/to/server.js", {}, 100); // 100ms timeout
		const connectPromise = client.connect();

		lastMockProc.stdout.emit("data", JSON.stringify({
			jsonrpc: "2.0", id: 1,
			result: { protocolVersion: "2024-11-05", capabilities: {} },
		}) + "\n");
		await connectPromise;

		const callPromise = client.callTool("commander_task", { operation: "list" });

		// Advance time past timeout
		vi.advanceTimersByTime(200);

		await expect(callPromise).rejects.toThrow(/timeout/i);

		vi.useRealTimers();
	});

	it("should terminate a subprocess that exceeds the JSON-RPC buffer limit", () => {
		const client = new McpClient("/path/to/server.js", {});
		const proc: any = lastMockProc;
		(client as any).proc = proc;
		(client as any).onData("x".repeat(8 * 1024 * 1024 + 1));
		expect(proc.kill).toHaveBeenCalled();
	});

	it("should kill subprocess on disconnect", async () => {
		const client = new McpClient("/path/to/server.js", {});
		const connectPromise = client.connect();

		lastMockProc.stdout.emit("data", JSON.stringify({
			jsonrpc: "2.0", id: 1,
			result: { protocolVersion: "2024-11-05", capabilities: {} },
		}) + "\n");
		await connectPromise;

		client.disconnect();
		expect(lastMockProc.kill).toHaveBeenCalled();
	});

	it("should reject pending calls when process dies", async () => {
		const client = new McpClient("/path/to/server.js", {});
		const connectPromise = client.connect();

		lastMockProc.stdout.emit("data", JSON.stringify({
			jsonrpc: "2.0", id: 1,
			result: { protocolVersion: "2024-11-05", capabilities: {} },
		}) + "\n");
		await connectPromise;

		const callPromise = client.callTool("commander_task", { operation: "list" });

		// Simulate process death
		lastMockProc.emit("close", 1);

		await expect(callPromise).rejects.toThrow(/process/i);
	});

	it("should reject the handshake and pending calls on a process error", async () => {
		const client = new McpClient("/path/to/server.js", {});
		const connectPromise = client.connect();

		lastMockProc.emit("error", new Error("spawn failed"));

		await expect(connectPromise).rejects.toThrow("spawn failed");
	});

	it("should report connection state accurately", async () => {
		const client = new McpClient("/path/to/server.js", {});
		expect(client.isConnected()).toBe(false);

		const connectPromise = client.connect();

		lastMockProc.stdout.emit("data", JSON.stringify({
			jsonrpc: "2.0", id: 1,
			result: { protocolVersion: "2024-11-05", capabilities: {} },
		}) + "\n");
		await connectPromise;

		expect(client.isConnected()).toBe(true);

		client.disconnect();
		expect(client.isConnected()).toBe(false);
	});
});
