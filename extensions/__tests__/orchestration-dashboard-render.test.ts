import { describe, expect, test } from "bun:test";
import { renderOrchestrationDashboard } from "../lib/orchestration-dashboard-render.ts";

const theme = { fg: (color: string, text: string) => `<${color}>${text}`, bold: (text: string) => `**${text}**` };

describe("orchestration dashboard renderer", () => {
	test("renders empty state and budget", () => {
		const lines = renderOrchestrationDashboard({ runs: [], limit: 8, mode: "PLAN", budget: { status: "0/100 tokens · $0.0000/$1.0000", blocked: false } }, 100, theme);
		expect(lines.join("\n")).toContain("ORCHESTRATION ACTIVITY · PLAN");
		expect(lines.join("\n")).toContain("No persisted runs");
		expect(lines.join("\n")).toContain("0/100 tokens");
	});

	test("renders bounded run rows with status and identifiers", () => {
		const lines = renderOrchestrationDashboard({
			limit: 2,
			modeMetrics: { PLAN: { runs: 2, succeeded: 1, failed: 1, stale: 0, running: 0, cancelled: 0, durationMs: 6_000, totalTokens: 1_234, costUsd: 0.0123 } },
			mode: "PLAN",
			runs: [
				{ runId: "run-success", actor: "dispatch-runtime", mode: "PLAN", status: "succeeded", durationMs: 3200, eventCount: 4, eventDir: "/tmp/run-success", totalTokens: 1234, costUsd: 0.0123, verificationStatus: "PASS", changedFiles: ["src/a.ts"] },
				{ runId: "run-failed", actor: "toolkit:builder", status: "failed", durationMs: 800, eventCount: 3, eventDir: "/tmp/run-failed" },
			],
		}, 80, theme);
		expect(lines).toHaveLength(5);
		expect(lines[3]).toContain("✓");
		expect(lines[1]).toContain("Metrics 2runs");
		expect(lines[3]).toContain("PASS");
		expect(lines[3]).toContain("PLAN");
		expect(lines[3]).toContain("Δ1");
		expect(lines[3]).toContain("1,234tok/$0.0123");
		expect(lines[4]).toContain("✗");
		expect(lines[3].length).toBeLessThanOrEqual(80);
	});

	test("shows a bounded recovery action for stale work", () => {
		const lines = renderOrchestrationDashboard({
			limit: 1,
			runs: [{ runId: "stale-run", actor: "subagent:builder", mode: "PLAN", status: "stale", eventCount: 4, eventDir: "/tmp/stale", recoveryAction: "subagent-resume", recoveryDispatchId: "builder-sa1-resume" }],
		}, 100, theme);
		expect(lines.join("\n")).toContain("resume:builder-sa1");
	});
});
