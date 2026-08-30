import { describe, expect, it } from "vitest";
import workspaceMemory from "../workspace-memory.ts";

describe("workspace memory", () => {
	it("does not register tools or commands in P0", () => {
		let registrations = 0;
		const pi = { registerCommand: () => { registrations++; }, registerTool: () => { registrations++; } };
		workspaceMemory(pi as never);
		expect(registrations).toBe(0);
	});
});
