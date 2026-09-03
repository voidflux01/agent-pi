import { afterEach, describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { capabilityConflict, getCapability, getCapabilityForTool, listCapabilities, registerCapability, registerDiscoveredCapability, resetCapabilitiesForTests, searchCapabilities, validateCapabilityArguments } from "../lib/capability-registry.ts";

afterEach(() => resetCapabilitiesForTests());

describe("capability registry", () => {
	test("registers a namespaced descriptor with inferred risk", () => {
		const descriptor = registerCapability({ name: "subagent_create", description: "Dispatch a worker to edit files" });
		expect(descriptor.ref).toBe("extensions.subagent_create");
		expect(descriptor.risk).toBe("agent");
		expect(descriptor.effect.resources).toEqual(["agent-runtime"]);
		expect(descriptor.execution).toBe("native_only");
		expect(getCapability("extensions.subagent_create")).toBe(descriptor);
	});

	test("searches descriptors deterministically", () => {
		registerCapability({ name: "read_report", description: "Read a persisted report" });
		registerCapability({ name: "subagent_create", description: "Run an agent" });
		expect(searchCapabilities("agent").map((entry) => entry.ref)).toEqual(["extensions.subagent_create"]);
		expect(listCapabilities().map((entry) => entry.ref)).toEqual(["extensions.read_report", "extensions.subagent_create"]);
	});

	test("validates nested arguments against the registered schema", () => {
		const descriptor = registerCapability({ name: "schema_target", inputSchema: Type.Object({ required: Type.String() }) });
		expect(validateCapabilityArguments(descriptor, { required: "ok" })).toEqual([]);
		expect(validateCapabilityArguments(descriptor, { required: 42 })[0]).toContain("/required");
	});

	test("detects non-commutative shared resources", () => {
		const left = registerCapability({ name: "left", risk: "write", effect: { resources: ["workspace"], ordering: "ordered" } });
		const right = registerCapability({ name: "right", risk: "execute", effect: { resources: ["workspace"], ordering: "unknown" } });
		expect(capabilityConflict(left, right)).toEqual(["workspace"]);
	});

	test("projects discovered MCP tools without making them compose executors", () => {
		const descriptor = registerDiscoveredCapability({ name: "mcp__docs__search", description: "Search current documentation" });
		expect(descriptor.provider).toBe("mcp");
		expect(getCapabilityForTool("mcp__docs__search")).toBe(descriptor);
		expect(descriptor.risk).toBe("network");
		expect(descriptor.execution).toBe("native_only");
	});

	test("retains discovered native schemas for inspection without enabling execution", () => {
		const schema = Type.Object({ path: Type.String() });
		const descriptor = registerDiscoveredCapability({ name: "find", provider: "builtin", description: "Find files", inputSchema: schema });
		expect(descriptor.inputSchema).toBe(schema);
		expect(descriptor.execution).toBe("native_only");
	});
});
