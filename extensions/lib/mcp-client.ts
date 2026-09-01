// ABOUTME: Generic MCP (Model Context Protocol) client over stdio using JSON-RPC 2.0.
// ABOUTME: Spawns a subprocess, communicates via line-delimited JSON on stdin/stdout.

import { spawn, type ChildProcess } from "child_process";
import { childEnvironment } from "./child-runtime.ts";

// ── JSON-RPC helpers ────────────────────────────────────────────────

export function formatJsonRpcRequest(id: number | undefined, method: string, params: Record<string, unknown>): string {
	const msg: Record<string, unknown> = { jsonrpc: "2.0", method, params };
	if (id !== undefined) msg.id = id;
	return JSON.stringify(msg);
}

export function parseJsonRpcLines(data: string): { messages: any[]; remainder: string } {
	const messages: any[] = [];
	let remainder = "";

	if (!data) return { messages, remainder };

	const lines = data.split("\n");
	// Last element is either empty (if data ended with \n) or a partial line
	remainder = lines.pop() ?? "";

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			messages.push(JSON.parse(trimmed));
		} catch {
			// Skip non-JSON lines (e.g. log output from server)
		}
	}

	return { messages, remainder };
}

// ── MCP Client ──────────────────────────────────────────────────────

type PendingCall = {
	resolve: (value: any) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

export class McpClient {
	private serverPath: string;
	private env: Record<string, string>;
	private timeoutMs: number;
	private proc: ChildProcess | null = null;
	private nextId = 1;
	private pending = new Map<number, PendingCall>();
	private buffer = "";
	private connected = false;
	private connecting: Promise<void> | null = null;
	private static readonly MAX_BUFFER_BYTES = 8 * 1024 * 1024;

	constructor(serverPath: string, env: Record<string, string>, timeoutMs = 60_000) {
		this.serverPath = serverPath;
		this.env = env;
		this.timeoutMs = timeoutMs;
	}

	async connect(): Promise<void> {
		if (this.connected) return;
		if (this.connecting) return this.connecting;
		const attempt = this.connectOnce();
		this.connecting = attempt;
		try {
			await attempt;
		} finally {
			if (this.connecting === attempt) this.connecting = null;
		}
	}

	private async connectOnce(): Promise<void> {
		// A partial JSON line belongs to the previous process and must never be
		// prepended to the next server's handshake response.
		this.buffer = "";
		this.proc = spawn("node", [this.serverPath], {
			stdio: ["pipe", "pipe", "pipe"],
			env: childEnvironment(this.env),
		});

		this.proc.stdout!.setEncoding("utf-8");
		const proc = this.proc;
		proc.stdout!.on("data", (chunk: string) => this.onData(chunk, proc));
		this.proc.stderr!.on("data", () => {}); // Drain stderr
		proc.on("close", () => this.onClose(proc));
		proc.on("error", (err) => this.onClose(proc, err));

		// Handle stdin errors (EPIPE when server dies) to prevent uncaught crash
		proc.stdin!.on("error", () => {
			this.onClose(proc);
		});

		// Send initialize handshake
		const initId = this.nextId++;
		const initMsg = formatJsonRpcRequest(initId, "initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "pi-mcp-client", version: "1.0.0" },
		});

		// Wait for initialize response
		const handshake = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(initId);
				try { this.proc?.kill(); } catch {}
				reject(new Error("MCP initialize timeout"));
			}, this.timeoutMs);

			this.pending.set(initId, {
				resolve: () => {
					clearTimeout(timer);
					// Send initialized notification
					const notif = formatJsonRpcRequest(undefined, "notifications/initialized", {});
					try {
						this.proc!.stdin!.write(notif + "\n");
					} catch {
						// Non-fatal — handshake already succeeded
					}
					this.connected = true;
					resolve();
				},
				reject: (err) => {
					clearTimeout(timer);
					reject(err);
				},
				timer,
			});
		});
		// Register the pending request before writing so a synchronous stream
		// error cannot race the handshake registration.
		try {
			proc.stdin!.write(initMsg + "\n");
		} catch (err) {
			try { proc.kill(); } catch {}
			this.onClose(proc, new Error(`MCP initialize write failed: ${(err as Error).message}`));
		}
		await handshake;
	}

	async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<any> {
		if (!this.proc || !this.connected) {
			throw new Error("MCP client not connected");
		}

		const id = this.nextId++;
		const msg = formatJsonRpcRequest(id, "tools/call", { name, arguments: args });

		const effectiveTimeout = timeoutMs ?? this.timeoutMs;
		return new Promise<any>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP tool call timeout after ${effectiveTimeout}ms`));
			}, effectiveTimeout);

			this.pending.set(id, { resolve, reject, timer });

			// Write after registering the pending handler so EPIPE triggers onClose
			// which rejects all pending calls cleanly instead of crashing
			try {
				this.proc!.stdin!.write(msg + "\n");
			} catch (err) {
				// Synchronous write error (stream already destroyed)
				this.pending.delete(id);
				clearTimeout(timer);
				reject(new Error(`MCP write failed: ${(err as Error).message}`));
			}
		});
	}

	disconnect(): void {
		this.connected = false;
		this.buffer = "";
		if (this.proc) {
			this.proc.kill();
			this.proc = null;
		}
		// Reject any pending calls
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error("MCP client disconnected"));
			this.pending.delete(id);
		}
	}

	isConnected(): boolean {
		return this.connected;
	}

	private onData(chunk: string, source?: ChildProcess): void {
		if (source && this.proc !== source) return;
		if (Buffer.byteLength(this.buffer) + Buffer.byteLength(chunk) > McpClient.MAX_BUFFER_BYTES) {
			try { (source || this.proc)?.kill(); } catch {}
			this.onClose(source);
			return;
		}
		const { messages, remainder } = parseJsonRpcLines(this.buffer + chunk);
		this.buffer = remainder;

		for (const msg of messages) {
			if (msg.id !== undefined && this.pending.has(msg.id)) {
				const pending = this.pending.get(msg.id)!;
				this.pending.delete(msg.id);
				clearTimeout(pending.timer);

				if (msg.error) {
					pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
				} else {
					pending.resolve(msg.result);
				}
			}
		}
	}

	private onClose(source?: ChildProcess, cause?: unknown): void {
		if (source && this.proc !== source) return;
		this.connected = false;
		this.proc = null;
		const detail = cause instanceof Error ? `: ${cause.message}` : "";
		// Reject all pending calls
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error(`MCP server process closed unexpectedly${detail}`));
			this.pending.delete(id);
		}
	}
}
