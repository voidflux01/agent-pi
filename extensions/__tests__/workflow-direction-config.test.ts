import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { workflowDirection } from "../lib/workflow-direction.ts";
import { configuredModelForAgent, AGENT_PI_CONFIG, AGENT_PI_GLOBAL_CONFIG_PATH } from "../lib/agent-pi-config.ts";

describe("workflow direction", () => {
	test("high risk always escalates regardless of status", () => {
		expect(workflowDirection({ status: "PASS", risk: "high" }).next).toBe("ASK_USER");
		expect(workflowDirection({ status: "FAIL", risk: "high" }).autonomy).toBe("interactive");
	});

	test("blocked, inconclusive and repeated failures stop retrying", () => {
		expect(workflowDirection({ status: "BLOCKED" }).next).toBe("ASK_USER");
		expect(workflowDirection({ status: "INCONCLUSIVE" }).next).toBe("ASK_USER");
		expect(workflowDirection({ status: "FAIL", attempt: 3 }).next).toBe("ASK_USER");
	});

	test("failure classes route to repair, replan, respec or environment", () => {
		expect(workflowDirection({ status: "FAIL", failure: "implementation" }).next).toBe("BUILD");
		expect(workflowDirection({ status: "FAIL", failure: "assumption" }).next).toBe("PLAN");
		expect(workflowDirection({ status: "FAIL", failure: "requirements" }).next).toBe("SPEC");
		expect(workflowDirection({ status: "FAIL", failure: "environment" }).next).toBe("ASK_USER");
	});

	test("pass reports; unverified collects evidence with parallel hint only when independent", () => {
		expect(workflowDirection({ status: "PASS" }).next).toBe("REPORT");
		expect(workflowDirection({ status: "UNVERIFIED" }).next).toBe("VERIFY");
		expect(workflowDirection({ status: "UNVERIFIED" }).parallel).toBeFalsy();
		expect(workflowDirection({ status: "UNVERIFIED", independentTasks: 2 }).parallel).toBe(true);
	});
});

describe("agent-pi config", () => {
	test("defaults: drafts opt-in (retrospective off), core workflow support on", () => {
		expect(AGENT_PI_CONFIG.workflowSupport?.enabled).toBe(true);
		expect(AGENT_PI_CONFIG.workflowSupport?.retrospective).toBe(false);
	});

	test("global config path is the user-level agent-pi.json", () => {
		expect(AGENT_PI_GLOBAL_CONFIG_PATH).toContain(join(".pi", "agent", "agent-pi.json"));
	});

	test("configuredModelForAgent resolves exact, suffixed and toolkit lookups", () => {
		expect(configuredModelForAgent("  Builder ")).toBe(AGENT_PI_CONFIG.models.byAgent["builder"]);
		expect(configuredModelForAgent("nonexistent-agent-xyz")).toBeUndefined();
		const toolkitModel = AGENT_PI_CONFIG.models.toolkit;
		expect(configuredModelForAgent("toolkit")).toBe(toolkitModel ?? undefined);
	});
});
