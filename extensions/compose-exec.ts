// ABOUTME: Fabric-inspired bounded composition tool for registered extension capabilities.
// ABOUTME: Executes independent steps in parallel, preserves ordered dependencies,
// and returns compact structured results without exposing intermediate noise.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { registerToolWithExecutor, getRegisteredToolExecutors } from "./lib/tool-executor-registry.ts";
import { capabilityConflict, getCapability, getCapabilityForTool, listCapabilities, registerCapability, validateCapabilityArguments } from "./lib/capability-registry.ts";
import { executeBuiltinTool, nestedApprovalBlock, nestedSecurityBlock } from "./tool-caller.ts";
import { applyExtensionDefaults } from "./lib/themeMap.ts";
import { createOrchestrationRun, RunBudgetError } from "./lib/orchestration-run.ts";
import { coordinationState } from "./lib/coordination-state.ts";

const Step = Type.Object({
	tool: Type.String({ description: "Capability name, e.g. tasks or dispatch_agent" }),
	arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	label: Type.Optional(Type.String({ description: "Short label for the returned audit" })),
	when: Type.Optional(Type.Object({
		step: Type.Integer({ minimum: 0, maximum: 15, description: "Prior step index to inspect" }),
		status: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("blocked"), Type.Literal("skipped")]),
	}, { description: "Only run when a prior sequential step has this status" })),
});

const ComposeParams = Type.Object({
	steps: Type.Array(Step, { minItems: 1, maxItems: 16, description: "Steps to execute" }),
	parallel: Type.Optional(Type.Boolean({ description: "Run independent steps concurrently" })),
	stop_on_error: Type.Optional(Type.Boolean({ description: "Stop after the first failed step in sequential mode" })),
});

type StepArgs = { tool: string; arguments?: Record<string, unknown>; label?: string; when?: { step: number; status: "completed" | "failed" | "blocked" | "skipped" } };

function resolveStepReferences(value: unknown, results: any[], currentIndex: number): { value?: unknown; error?: string } {
	if (typeof value === "string") {
		const match = value.match(/^\$STEP_(\d+)_(TEXT|DETAILS(?:\..+)?)$/);
		if (!match) return { value };
		const index = Number(match[1]);
		if (index >= currentIndex || !results[index]) return { error: `step reference must point to a completed prior step: ${value}` };
		const result = results[index];
		if (match[2] === "TEXT") return { value: String(result.result?.text ?? "") };
		let selected: unknown = result.result?.details;
		for (const key of match[2].slice("DETAILS.".length).split(".")) {
			if (!selected || typeof selected !== "object") return { error: `missing step detail: ${value}` };
			selected = (selected as Record<string, unknown>)[key];
		}
		return { value: selected };
	}
	if (Array.isArray(value)) {
		const output: unknown[] = [];
		for (const item of value) { const resolved = resolveStepReferences(item, results, currentIndex); if (resolved.error) return resolved; output.push(resolved.value); }
		return { value: output };
	}
	if (value && typeof value === "object") {
		const output: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) { const resolved = resolveStepReferences(item, results, currentIndex); if (resolved.error) return resolved; output[key] = resolved.value; }
		return { value: output };
	}
	return { value };
}

function containsStepReference(value: unknown): boolean {
	if (typeof value === "string") return /^\$STEP_\d+_(TEXT|DETAILS(?:\..+)?)$/.test(value);
	if (Array.isArray(value)) return value.some(containsStepReference);
	return Boolean(value && typeof value === "object" && Object.values(value).some(containsStepReference));
}

function toolName(ref: string): string {
	return ref.startsWith("extensions.") ? ref.slice("extensions.".length) : ref;
}

function compactResult(value: any): unknown {
	if (!value || typeof value !== "object") return value;
	const text = Array.isArray(value.content)
		? value.content.filter((block: any) => block?.type === "text").map((block: any) => block.text).join("\n").slice(0, 4000)
		: undefined;
	return { ...(text === undefined ? {} : { text }), ...(value.details === undefined ? {} : { details: value.details }) };
}

const BUILTIN_READ_SCHEMA = Type.Object({
	path: Type.String({ minLength: 1 }),
	offset: Type.Optional(Type.Integer({ minimum: 1 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
});

export default function (pi: ExtensionAPI) {
	registerToolWithExecutor(pi, {
		name: "compose_exec",
		label: "Compose Exec",
		description: "Run up to 16 registered extension capabilities as one bounded composition. Sequential steps may consume prior output with $STEP_n_TEXT or $STEP_n_DETAILS.path and use a safe when status condition. Use parallel=true only for independent steps. The safe built-in read capability is supported; other built-ins remain on Pi's native path.",
		parameters: ComposeParams,
		capabilityRisk: "execute",
		capabilityEffect: { resources: ["extension-runtime"], ordering: "unknown" },
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const steps = params.steps as StepArgs[];
			const parallel = params.parallel === true;
			const stopOnError = params.stop_on_error !== false;
			const executors = getRegisteredToolExecutors();
			const cwd = ctx?.cwd || process.cwd();
			const run = createOrchestrationRun({ context: ctx, actor: "compose_exec", mode: coordinationState().mode, workspaceCwd: cwd });
			const parallelConflict = parallel ? (() => {
				const capabilities = steps.map((step) => getCapability(`extensions.${toolName(step.tool)}`));
				for (let left = 0; left < capabilities.length; left += 1) {
					for (let right = left + 1; right < capabilities.length; right += 1) {
						const a = capabilities[left];
						const b = capabilities[right];
						if (a && b) {
							const overlap = capabilityConflict(a, b);
							if (overlap.length > 0) return `${a.name} ↔ ${b.name}: ${overlap.join(", ")}`;
						}
					}
				}
				return undefined;
			})() : undefined;
			const runStep = async (step: StepArgs, index: number, priorResults: any[]) => {
				if (step.when) {
					if (parallel) return { index, tool: toolName(step.tool), status: "blocked", error: "when conditions require sequential mode" };
					if (step.when.step >= index || !priorResults[step.when.step]) return { index, tool: toolName(step.tool), status: "blocked", error: "when must reference a prior step" };
					if (priorResults[step.when.step].status !== step.when.status) return { index, tool: toolName(step.tool), status: "skipped", reason: `step ${step.when.step} was ${priorResults[step.when.step].status}` };
				}
				if (parallel && containsStepReference(step.arguments)) return { index, tool: toolName(step.tool), status: "blocked", error: "step references require sequential mode" };
				const name = toolName(step.tool);
				if (name === "compose_exec" || name === "call_tool" || name === "tool_search") {
					return { index, tool: name, status: "blocked", error: "meta-tool recursion is not allowed" };
				}
				const capability = getCapability(step.tool.startsWith("extensions.") ? step.tool : `extensions.${name}`)
					?? getCapabilityForTool(name)
					?? (name === "read" ? registerCapability({ name, provider: "builtin", description: "Read a workspace file", inputSchema: BUILTIN_READ_SCHEMA, risk: "read", effect: { ordering: "commutative" } }) : undefined);
				const executor = executors[name] ?? (name === "read"
					? ((_: string, args: Record<string, unknown>, signal: AbortSignal | undefined, __: unknown, context: any) => executeBuiltinTool("read", args, context, signal, pi))
					: undefined);
				if (!capability || !executor) return { index, tool: name, status: "blocked", error: "capability is not registered for in-process execution" };
				const resolvedArgs = resolveStepReferences(step.arguments ?? {}, priorResults, index);
				if (resolvedArgs.error) return { index, tool: name, status: "blocked", error: resolvedArgs.error };
				const args = (resolvedArgs.value ?? {}) as Record<string, unknown>;
				const schemaErrors = validateCapabilityArguments(capability, args);
				if (schemaErrors.length > 0) return { index, tool: name, status: "blocked", error: `invalid arguments: ${schemaErrors.join("; ")}` };
				const securityBlock = nestedSecurityBlock(name, args, cwd);
				if (securityBlock) return { index, tool: name, status: "blocked", error: `security: ${securityBlock}` };
				const approvalBlock = nestedApprovalBlock(name, args, cwd);
				if (approvalBlock) return { index, tool: name, status: "blocked", error: `approval: ${approvalBlock}` };
				try {
					run.consumeStep();
					run.record("step.started", { index, tool: name, risk: capability.risk, parallel });
					const result = await executor(`${toolCallId}-compose-${index}`, args, signal, onUpdate, ctx);
					run.record("step.completed", { index, tool: name });
					return { index, tool: name, status: "completed", result: compactResult(result), risk: capability.risk };
				} catch (error) {
					run.record("step.failed", { index, tool: name, error: error instanceof Error ? error.message : String(error) });
					const message = error instanceof RunBudgetError ? `${error.message}; reduce steps or split the composition` : error instanceof Error ? error.message : String(error);
					return { index, tool: name, status: "failed", error: message, risk: capability.risk };
				}
			};

			const results: any[] = [];
			if (parallelConflict) {
				results.push(...steps.map((step, index) => ({ index, tool: toolName(step.tool), status: "blocked", error: `parallel effect conflict: ${parallelConflict}` })));
			} else if (parallel) results.push(...await Promise.all(steps.map((step, index) => runStep(step, index, []))));
			else {
				for (let index = 0; index < steps.length; index += 1) {
					const result = await runStep(steps[index]!, index, results);
					results.push(result);
					if (stopOnError && (result.status === "failed" || result.status === "blocked")) break;
				}
			}
			const failed = results.filter((result) => result.status === "failed" || result.status === "blocked").length;
			run.finish(failed ? "failed" : "succeeded", { total: steps.length, completed: results.length - failed, failed });
			return {
				content: [{ type: "text" as const, text: `compose_exec ${failed ? "completed with issues" : "completed"}: ${results.length}/${steps.length} step(s)` }],
				details: { runId: run.runId, eventDir: run.eventDir, parallel, total: steps.length, completed: results.filter((result) => result.status === "completed").length, failed, results },
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("compose_exec ")) + theme.fg("accent", `${args.steps?.length ?? 0} step(s)${args.parallel ? " · parallel" : ""}`), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as any;
			const summary = `${details?.completed ?? 0}/${details?.total ?? 0} completed${details?.failed ? ` · ${details.failed} issue(s)` : ""}`;
			if (!expanded) return new Text(theme.fg(details?.failed ? "warning" : "success", summary), 0, 0);
			return new Text(theme.fg(details?.failed ? "warning" : "success", summary) + "\n" + theme.fg("muted", JSON.stringify(details?.results ?? [], null, 2)), 0, 0);
		},
	});

	pi.registerCommand("capabilities", {
		description: "List registered executable capabilities",
		handler: async (_args, ctx) => {
			const capabilities = listCapabilities();
			ctx.ui.notify(capabilities.length ? capabilities.map((capability) => `${capability.ref} [${capability.risk}]`).join("\n") : "No capabilities registered", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => applyExtensionDefaults(import.meta.url, ctx));
}
