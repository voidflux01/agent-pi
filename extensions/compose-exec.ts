// ABOUTME: Fabric-inspired bounded composition tool for registered extension capabilities.
// ABOUTME: Executes independent steps in parallel, preserves ordered dependencies,
// and returns compact structured results without exposing intermediate noise.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { registerToolWithExecutor, getRegisteredToolExecutors } from "./lib/tool-executor-registry.ts";
import { getCapability, listCapabilities, validateCapabilityArguments } from "./lib/capability-registry.ts";
import { nestedApprovalBlock, nestedSecurityBlock } from "./tool-caller.ts";
import { applyExtensionDefaults } from "./lib/themeMap.ts";
import { createOrchestrationRun, RunBudgetError } from "./lib/orchestration-run.ts";

const Step = Type.Object({
	tool: Type.String({ description: "Capability name, e.g. tasks or dispatch_agent" }),
	arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	label: Type.Optional(Type.String({ description: "Short label for the returned audit" })),
});

const ComposeParams = Type.Object({
	steps: Type.Array(Step, { minItems: 1, maxItems: 16, description: "Steps to execute" }),
	parallel: Type.Optional(Type.Boolean({ description: "Run independent steps concurrently" })),
	stop_on_error: Type.Optional(Type.Boolean({ description: "Stop after the first failed step in sequential mode" })),
});

type StepArgs = { tool: string; arguments?: Record<string, unknown>; label?: string };

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

export default function (pi: ExtensionAPI) {
	registerToolWithExecutor(pi, {
		name: "compose_exec",
		label: "Compose Exec",
		description: "Run up to 16 registered extension capabilities as one bounded composition. Use parallel=true only when steps are independent. Built-in Pi tools are not proxied by this first version; call them directly.",
		parameters: ComposeParams,
		capabilityRisk: "execute",
		capabilityEffect: { resources: ["extension-runtime"], ordering: "unknown" },
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const steps = params.steps as StepArgs[];
			const parallel = params.parallel === true;
			const stopOnError = params.stop_on_error !== false;
			const run = createOrchestrationRun({ context: ctx, actor: "compose_exec" });
			const executors = getRegisteredToolExecutors();
			const cwd = ctx?.cwd || process.cwd();
			const runStep = async (step: StepArgs, index: number) => {
				const name = toolName(step.tool);
				if (name === "compose_exec" || name === "call_tool" || name === "tool_search") {
					return { index, tool: name, status: "blocked", error: "meta-tool recursion is not allowed" };
				}
				const capability = getCapability(step.tool.startsWith("extensions.") ? step.tool : `extensions.${name}`);
				const executor = executors[name];
				if (!capability || !executor) return { index, tool: name, status: "blocked", error: "capability is not registered for in-process execution" };
				const args = step.arguments ?? {};
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
			if (parallel) results.push(...await Promise.all(steps.map(runStep)));
			else {
				for (let index = 0; index < steps.length; index += 1) {
					const result = await runStep(steps[index]!, index);
					results.push(result);
					if (stopOnError && (result.status === "failed" || result.status === "blocked")) break;
				}
			}
			const failed = results.filter((result) => result.status !== "completed").length;
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
