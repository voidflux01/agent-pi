// ABOUTME: Fabric-inspired capability catalog for executable extension tools.
// ABOUTME: Keeps discovery metadata, risk, effects, and executable handlers together.

import { Value } from "@sinclair/typebox/value";

export type CapabilityRisk = "read" | "write" | "execute" | "network" | "agent";
export type CapabilityOrdering = "commutative" | "ordered" | "unknown";

export interface CapabilityEffect { resources?: string[]; ordering?: CapabilityOrdering; }
export interface CapabilityDescriptor {
	ref: string; provider: "extensions"; name: string; description: string;
	inputSchema?: unknown; risk: CapabilityRisk; effect: CapabilityEffect; registeredAt: number;
}

const KEY = "__piCapabilityRegistry";
function store(): Map<string, CapabilityDescriptor> {
	const g = globalThis as any;
	if (!(g[KEY] instanceof Map)) g[KEY] = new Map<string, CapabilityDescriptor>();
	return g[KEY];
}

function inferRisk(name: string, description: string): CapabilityRisk {
	const text = `${name} ${description}`.toLowerCase();
	if (/agent|subagent|dispatch|spawn|worker/.test(text)) return "agent";
	if (/network|http|web|url|fetch|browser|search/.test(text)) return "network";
	if (/write|edit|delete|remove|create|mutat|install|execute|run|bash/.test(text)) return "execute";
	return "read";
}

function inferEffect(name: string, risk: CapabilityRisk): CapabilityEffect {
	if (risk === "read") return { ordering: "commutative" };
	return { resources: [/agent|subagent|dispatch|spawn|worker/.test(name) ? "agent-runtime" : "workspace"], ordering: "unknown" };
}

export function registerCapability(input: { name: string; description?: string; inputSchema?: unknown; risk?: CapabilityRisk; effect?: CapabilityEffect }): CapabilityDescriptor {
	const description = input.description ?? "";
	const risk = input.risk ?? inferRisk(input.name, description);
	const descriptor: CapabilityDescriptor = {
		ref: `extensions.${input.name}`, provider: "extensions", name: input.name, description,
		...(input.inputSchema === undefined ? {} : { inputSchema: input.inputSchema }),
		risk, effect: input.effect ?? inferEffect(input.name, risk), registeredAt: Date.now(),
	};
	store().set(descriptor.ref, descriptor);
	return descriptor;
}

export function getCapability(ref: string): CapabilityDescriptor | undefined { return store().get(ref); }
export function listCapabilities(): CapabilityDescriptor[] { return [...store().values()].sort((a, b) => a.ref.localeCompare(b.ref)); }
export function validateCapabilityArguments(capability: CapabilityDescriptor, value: unknown): string[] {
	if (!capability.inputSchema || typeof capability.inputSchema !== "object") return [];
	try {
		return [...Value.Errors(capability.inputSchema as any, value)].slice(0, 8).map((error) => `${error.path || "/arguments"}: ${error.message}`);
	} catch (error) {
		return [`schema validation unavailable: ${error instanceof Error ? error.message : String(error)}`];
	}
}
export function searchCapabilities(query: string): CapabilityDescriptor[] {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return listCapabilities();
	return listCapabilities().map((capability) => {
		const text = `${capability.ref} ${capability.description} ${capability.risk} ${capability.effect.resources?.join(" ") ?? ""}`.toLowerCase();
		const score = terms.reduce((total, term) => total + (text.includes(term) ? (capability.ref.includes(term) ? 3 : 1) : 0), 0);
		return { capability, score };
	}).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.capability.ref.localeCompare(b.capability.ref)).map((entry) => entry.capability);
}
export function resetCapabilitiesForTests(): void { store().clear(); }
