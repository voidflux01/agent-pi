/**
 * Step definitions for features/agent-email.feature
 *
 * Tests the send_email tool which proxies to commander_agentmail (AgentMail).
 * Mocks the Commander gate and tool calls to avoid real email sends.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import sendEmailExt from "../send-email";

// ── Test Helpers ─────────────────────────────────────────────────────

function createPiMock() {
	let tool: any;
	return {
		registerTool(def: any) {
			tool = def;
		},
		getTool() {
			return tool;
		},
	};
}

/** Set up the Commander gate as "available" on globalThis */
function mockCommanderAvailable() {
	(globalThis as any).__piCommanderGate = { status: "available" };
}

/** Set up the Commander gate as NOT available */
function mockCommanderUnavailable() {
	(globalThis as any).__piCommanderGate = null;
}

/** Create a mock ctx that has callTool which captures calls */
function createMockCtx(response?: any) {
	const calls: { name: string; params: any }[] = [];
	return {
		calls,
		callTool: vi.fn(async (name: string, params: any) => {
			calls.push({ name, params });
			return response || {
				content: [{ type: "text" as const, text: 'Email sent successfully. Message ID: msg_abc123' }],
				details: { success: true, messageId: "msg_abc123" },
			};
		}),
		cwd: "/test",
	};
}

let savedGate: any;

beforeEach(() => {
	savedGate = (globalThis as any).__piCommanderGate;
	mockCommanderAvailable();
});

afterEach(() => {
	(globalThis as any).__piCommanderGate = savedGate;
	vi.restoreAllMocks();
});

// ── Feature: Agent Email Sending ─────────────────────────────────────

describe("Feature: Agent Email Sending", () => {
	describe("Tool Registration", () => {
		it("should register a send_email tool", () => {
			const pi = createPiMock();
			sendEmailExt(pi as any);
			const tool = pi.getTool();

			expect(tool).toBeDefined();
			expect(tool.name).toBe("send_email");
			expect(tool.label).toBe("Send Email");
			expect(tool.description).toContain("AgentMail");
		});
	});

	// ── Scenario: Agent sends a completion report via email ──────────

	describe("Scenario: Agent sends a completion report via email", () => {
		it("Given Commander is available, When agent sends a report, Then commander_agentmail is called with send:report", async () => {
			const pi = createPiMock();
			sendEmailExt(pi as any);
			const tool = pi.getTool();
			const ctx = createMockCtx();

			const result = await tool.execute("1", {
				type: "report",
				report_name: "Feature Implementation Complete",
				body: "## Summary\nAdded OAuth login with Google provider",
			}, null, null, ctx);

			// Then — commander_agentmail was called
			expect(ctx.callTool).toHaveBeenCalledOnce();
			const [toolName, params] = ctx.callTool.mock.calls[0];
			expect(toolName).toBe("commander_agentmail");
			expect(params.operation).toBe("send:report");
			expect(params.report_name).toBe("Feature Implementation Complete");
			expect(params.content).toContain("OAuth login");
		});
	});

	// ── Scenario: Agent sends report with custom recipient ───────────

	describe("Scenario: Agent sends report to custom recipient", () => {
		it("Given a custom to address, Then it is passed through to commander_agentmail", async () => {
			const pi = createPiMock();
			sendEmailExt(pi as any);
			const tool = pi.getTool();
			const ctx = createMockCtx();

			await tool.execute("1", {
				type: "report",
				report_name: "Deploy Report",
				body: "Deployed v2.0",
				to: "team@example.com",
			}, null, null, ctx);

			const [, params] = ctx.callTool.mock.calls[0];
			expect(params.to).toBe("team@example.com");
			expect(params.operation).toBe("send:report");
		});
	});

	// ── Scenario: Agent sends a generic email with custom content ────

	describe("Scenario: Agent sends a generic email with custom content", () => {
		it("Given subject and body, When agent sends generic email, Then commander_agentmail send:custom is called", async () => {
			const pi = createPiMock();
			sendEmailExt(pi as any);
			const tool = pi.getTool();
			const ctx = createMockCtx();

			await tool.execute("1", {
				subject: "Build Results",
				body: "All 42 tests passed. No errors.",
			}, null, null, ctx);

			const [toolName, params] = ctx.callTool.mock.calls[0];
			expect(toolName).toBe("commander_agentmail");
			expect(params.operation).toBe("send:custom");
			expect(params.subject).toBe("Build Results");
			expect(params.content).toBe("All 42 tests passed. No errors.");
			expect(params.format).toBe("markdown");
		});
	});

	// ── Scenario: Agent sends HTML email ─────────────────────────────

	describe("Scenario: Agent sends HTML email", () => {
		it("Given html parameter, Then format is set to html", async () => {
			const pi = createPiMock();
			sendEmailExt(pi as any);
			const tool = pi.getTool();
			const ctx = createMockCtx();

			await tool.execute("1", {
				subject: "Styled Email",
				html: "<h1>Hello</h1><p>World</p>",
			}, null, null, ctx);

			const [, params] = ctx.callTool.mock.calls[0];
			expect(params.content).toBe("<h1>Hello</h1><p>World</p>");
			expect(params.format).toBe("html");
		});
	});

	// ── Scenario: Agent sends a briefing ─────────────────────────────

	describe("Scenario: Agent sends a briefing email", () => {
		it("Given briefing type, Then commander_agentmail send:briefing is called", async () => {
			const pi = createPiMock();
			sendEmailExt(pi as any);
			const tool = pi.getTool();
			const ctx = createMockCtx();

			await tool.execute("1", {
				type: "briefing",
				body: "# Morning Briefing\n- 3 tasks completed\n- 2 PRs merged",
			}, null, null, ctx);

			const [toolName, params] = ctx.callTool.mock.calls[0];
			expect(toolName).toBe("commander_agentmail");
			expect(params.operation).toBe("send:briefing");
			expect(params.content).toContain("Morning Briefing");
		});
	});

	// ── Scenario: Commander not available ────────────────────────────

	describe("Scenario: Commander not available", () => {
		it("Given Commander is not connected, Then tool returns error", async () => {
			mockCommanderUnavailable();

			const pi = createPiMock();
			sendEmailExt(pi as any);
			const tool = pi.getTool();

			const result = await tool.execute("1", {
				subject: "Test",
				body: "Hello",
			}, null, null, {});

			expect(result.details.success).toBe(false);
			expect(result.content[0].text).toContain("Commander");
		});
	});

	// ── Scenario: Email fails when subject is missing ────────────────

	describe("Scenario: Email fails when subject is missing", () => {
		it("Given no subject for generic email, Then tool returns error mentioning subject", async () => {
			const pi = createPiMock();
			sendEmailExt(pi as any);
			const tool = pi.getTool();

			const result = await tool.execute("1", {
				body: "Hello",
			}, null, null, {});

			expect(result.details.success).toBe(false);
			expect(result.content[0].text.toLowerCase()).toContain("subject");
		});
	});

	// ── Scenario: Email fails when body is missing ───────────────────

	describe("Scenario: Email fails when body is missing (generic)", () => {
		it("Given no body for generic email, Then tool returns error mentioning body", async () => {
			const pi = createPiMock();
			sendEmailExt(pi as any);
			const tool = pi.getTool();

			const result = await tool.execute("1", {
				subject: "Test",
			}, null, null, {});

			expect(result.details.success).toBe(false);
			expect(result.content[0].text.toLowerCase()).toContain("body");
		});
	});

	// ── Scenario: Email fails when body is missing (report) ──────────

	describe("Scenario: Email fails when body is missing (report)", () => {
		it("Given no body for report email, Then tool returns error", async () => {
			const pi = createPiMock();
			sendEmailExt(pi as any);
			const tool = pi.getTool();

			const result = await tool.execute("1", {
				type: "report",
				report_name: "Test Report",
			}, null, null, {});

			expect(result.details.success).toBe(false);
			expect(result.content[0].text.toLowerCase()).toContain("content");
		});
	});

	// ── Scenario: Email fails when body is missing (briefing) ────────

	describe("Scenario: Email fails when body is missing (briefing)", () => {
		it("Given no body for briefing, Then tool returns error", async () => {
			const pi = createPiMock();
			sendEmailExt(pi as any);
			const tool = pi.getTool();

			const result = await tool.execute("1", {
				type: "briefing",
			}, null, null, {});

			expect(result.details.success).toBe(false);
			expect(result.content[0].text.toLowerCase()).toContain("content");
		});
	});

	// ── Scenario: commander_agentmail returns error ───────────────────

	describe("Scenario: AgentMail returns an error", () => {
		it("Given the AgentMail API fails, Then the error is propagated", async () => {
			const pi = createPiMock();
			sendEmailExt(pi as any);
			const tool = pi.getTool();

			const ctx = createMockCtx({
				content: [{ type: "text" as const, text: "Failed to send report email: rate_limit_exceeded" }],
				details: { success: false, error: "rate_limit_exceeded" },
			});

			const result = await tool.execute("1", {
				type: "report",
				report_name: "Test",
				body: "Content",
			}, null, null, ctx);

			expect(result.content[0].text).toContain("rate_limit_exceeded");
		});
	});

	// ── Scenario: Default format is markdown ─────────────────────────

	describe("Scenario: Default format is markdown", () => {
		it("Given body without explicit format, Then format defaults to markdown", async () => {
			const pi = createPiMock();
			sendEmailExt(pi as any);
			const tool = pi.getTool();
			const ctx = createMockCtx();

			await tool.execute("1", {
				subject: "Test",
				body: "# Hello\n\nWorld",
			}, null, null, ctx);

			const [, params] = ctx.callTool.mock.calls[0];
			expect(params.format).toBe("markdown");
		});
	});

	// ── Scenario: Report auto-generates report_name from subject ─────

	describe("Scenario: Report uses subject as fallback report_name", () => {
		it("Given report type with subject but no report_name, Then subject is used", async () => {
			const pi = createPiMock();
			sendEmailExt(pi as any);
			const tool = pi.getTool();
			const ctx = createMockCtx();

			await tool.execute("1", {
				type: "report",
				subject: "My Custom Subject",
				body: "Report content here",
			}, null, null, ctx);

			const [, params] = ctx.callTool.mock.calls[0];
			expect(params.report_name).toBe("My Custom Subject");
		});
	});

	// ── Render Helpers ───────────────────────────────────────────────

	describe("Render helpers", () => {
		const mockTheme = {
			fg: (_: string, text: string) => text,
			bold: (text: string) => text,
		};

		it("renderCall shows type and recipient", () => {
			const pi = createPiMock();
			sendEmailExt(pi as any);
			const tool = pi.getTool();

			const result = tool.renderCall({ type: "report", to: "user@test.com" }, mockTheme);
			expect(result.text).toContain("report");
			expect(result.text).toContain("user@test.com");
		});

		it("renderResult shows success", () => {
			const pi = createPiMock();
			sendEmailExt(pi as any);
			const tool = pi.getTool();

			const result = tool.renderResult(
				{ content: [{ type: "text", text: "Email sent successfully" }], details: { success: true } },
				{},
				mockTheme,
			);
			expect(result.text).toContain("✓");
		});

		it("renderResult shows error", () => {
			const pi = createPiMock();
			sendEmailExt(pi as any);
			const tool = pi.getTool();

			const result = tool.renderResult(
				{ content: [{ type: "text", text: "failed: no_recipient" }], details: { error: "no_recipient", success: false } },
				{},
				mockTheme,
			);
			expect(result.text).toContain("failed");
		});
	});
});
