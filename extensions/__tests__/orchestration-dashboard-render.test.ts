import { describe, expect, test } from "bun:test";
import { renderOrchestrationDashboard } from "../lib/orchestration-dashboard-render.ts";

const theme = { fg: (color: string, text: string) => `<${color}>${text}`, bold: (text: string) => `**${text}**` };

describe("orchestration dashboard renderer", () => {
	test("renders empty state and budget", () => {
		const lines = renderOrchestrationDashboard({ runs: [], limit: 8, budget: { status: "0/100 tokens · $0.0000/$1.0000", blocked: false } }, 100, theme);
		expect(lines.join("\n")).toContain("ORCHESTRATION ACTIVITY");
		expect(lines.join("\n")).toContain("No persisted runs");
		expect(lines.join("\n")).toContain("0/100 tokens");
	});

	test("renders bounded run rows with status and identifiers", () => {
		const lines = renderOrchestrationDashboard({
			limit: 2,
			runs: [
				{ runId: "run-success", actor: "dispatch-runtime", mode: "PLAN", status: "succeeded", durationMs: 3200, eventCount: 4, eventDir: "/tmp/run-success", verificationStatus: "PASS", changedFiles: ["src/a.ts"] },
				{ runId: "run-failed", actor: "toolkit:builder", status: "failed", durationMs: 800, eventCount: 3, eventDir: "/tmp/run-failed" },
			],
		}, 80, theme);
		expect(lines).toHaveLength(4);
		expect(lines[2]).toContain("✓");
		expect(lines[2]).toContain("PASS");
		expect(lines[2]).toContain("PLAN");
		expect(lines[2]).toContain("Δ1");
		expect(lines[3]).toContain("✗");
		expect(lines[2].length).toBeLessThanOrEqual(80);
	});
});
