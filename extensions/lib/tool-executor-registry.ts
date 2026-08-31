// ABOUTME: Keeps executable extension-tool handlers available to call_tool.
// ABOUTME: Pi exposes tool metadata through getAllTools(), so registration must
// explicitly publish the handler for safe in-process composition.

export interface RegisteredToolDefinition {
	name: string;
	execute: (...args: any[]) => any;
}

const EXECUTOR_KEY = "__piRegisteredToolExecutors";

function executorMap(): Record<string, RegisteredToolDefinition["execute"]> {
	const g = globalThis as any;
	if (!g[EXECUTOR_KEY] || typeof g[EXECUTOR_KEY] !== "object") {
		g[EXECUTOR_KEY] = Object.create(null);
	}
	return g[EXECUTOR_KEY];
}

/** Register a tool and publish its handler for in-process tool composition. */
export function registerToolWithExecutor(pi: { registerTool: (definition: any) => void }, definition: RegisteredToolDefinition & Record<string, any>): void {
	pi.registerTool(definition);
	executorMap()[definition.name] = definition.execute;
}

export function getRegisteredToolExecutors(): Record<string, RegisteredToolDefinition["execute"]> {
	return { ...executorMap() };
}

