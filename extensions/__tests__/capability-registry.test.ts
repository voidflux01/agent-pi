import { afterEach, describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { getCapability, listCapabilities, registerCapability, resetCapabilitiesForTests, searchCapabilities, validateCapabilityArguments } from "../lib/capability-registry.ts";

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

	test("validates nested arguments against the registered schema", () => {
		const descriptor = registerCapability({ name: "schema_target", inputSchema: Type.Object({ required: Type.String() }) });
		expect(validateCapabilityArguments(descriptor, { required: "ok" })).toEqual([]);
		expect(validateCapabilityArguments(descriptor, { required: 42 })[0]).toContain("/required");
	});
});
