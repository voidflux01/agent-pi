// ABOUTME: Shared lifecycle hook for the canonical subagent_create dispatcher.
// ABOUTME: Mode-owned workflows validate dispatches and consume results here.

export type WorkflowMode = "NORMAL" | "TEAM" | "PIPELINE" | "CHAIN";

export interface WorkflowDispatchResult {
	mode: WorkflowMode;
	name: string;
	task: string;
	status: "done" | "error";
	output: string;
	fullOutput: string;
	fullOutputPath: string;
	exitCode: number;
	batch: boolean;
}

export interface WorkflowDispatchHook {
	before?: (input: { name: string; task: string; batch: boolean }) => string | undefined;
	after?: (result: WorkflowDispatchResult) => void;
}

const hooks = new Map<WorkflowMode, WorkflowDispatchHook>();

export function registerWorkflowDispatchHook(mode: WorkflowMode, hook: WorkflowDispatchHook): void {
	hooks.set(mode, hook);
}

export function workflowDispatchBefore(mode: string, input: { name: string; task: string; batch: boolean }): string | undefined {
	return hooks.get(mode as WorkflowMode)?.before?.(input);
}

export function workflowDispatchAfter(result: WorkflowDispatchResult): void {
	hooks.get(result.mode)?.after?.(result);
}
