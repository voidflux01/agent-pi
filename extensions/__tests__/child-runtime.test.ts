import { describe, expect, it } from "bun:test";
import { childEnvironment } from "../lib/child-runtime.ts";

describe("child process environment boundary", () => {
	it("does not inherit the parent's Pi home directory", () => {
		const oldDir = process.env.PI_CODING_AGENT_DIR;
		const oldPkg = process.env.PI_PACKAGE_DIR;
		process.env.PI_CODING_AGENT_DIR = "/tmp/parent-pi-home";
		process.env.PI_PACKAGE_DIR = "/tmp/parent-pi-packages";
		try {
			const env = childEnvironment({ PI_SUBAGENT: "1" });
			expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
			expect(env.PI_PACKAGE_DIR).toBeUndefined();
			expect(env.PI_SUBAGENT).toBe("1");
		} finally {
			if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
			if (oldPkg === undefined) delete process.env.PI_PACKAGE_DIR; else process.env.PI_PACKAGE_DIR = oldPkg;
		}
	});

	it("does not inherit provider credentials by default", () => {
		const oldOpenAI = process.env.OPENAI_API_KEY;
		const oldAnthropic = process.env.ANTHROPIC_API_KEY;
		process.env.OPENAI_API_KEY = "secret";
		process.env.ANTHROPIC_API_KEY = "secret";
		try {
			const env = childEnvironment({ AGENTMAIL_API_KEY: "scoped", PI_SUBAGENT: "1" });
			expect(env.OPENAI_API_KEY).toBeUndefined();
			expect(env.ANTHROPIC_API_KEY).toBeUndefined();
			expect(env.AGENTMAIL_API_KEY).toBe("scoped");
			expect(env.PI_SUBAGENT).toBe("1");
		} finally {
			if (oldOpenAI === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldOpenAI;
			if (oldAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = oldAnthropic;
		}
	});
});
