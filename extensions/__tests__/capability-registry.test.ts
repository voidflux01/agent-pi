import { afterEach, describe, expect, test } from "bun:test";
import { getCapability, listCapabilities, registerCapability, resetCapabilitiesForTests, searchCapabilities } from "../lib/capability-registry.ts";

afterEach(() => resetCapabilitiesForTests());

describe("capability registry", () => {
	test("registers a namespaced descriptor with inferred risk", () => {
		const descriptor = registerCapability({ name: "dispatch_agent", description: "Dispatch a worker to edit files" });
		expect(descriptor.ref).toBe("extensions.dispatch_agent");
		expect(descriptor.risk).toBe("agent");
		expect(descriptor.effect.resources).toEqual(["agent-runtime"]);
		expect(getCapability("extensions.dispatch_agent")).toBe(descriptor);
	});

	test("searches descriptors deterministically", () => {
		registerCapability({ name: "read_report", description: "Read a persisted report" });
		registerCapability({ name: "dispatch_agent", description: "Run an agent" });
		expect(searchCapabilities("agent").map((entry) => entry.ref)).toEqual(["extensions.dispatch_agent"]);
		expect(listCapabilities().map((entry) => entry.ref)).toEqual(["extensions.dispatch_agent", "extensions.read_report"]);
	});
});
