// ABOUTME: Fabric-inspired bounded composition tool for registered extension capabilities.
// ABOUTME: Executes independent steps in parallel, preserves ordered dependencies,
// and returns compact structured results without exposing intermediate noise.

import type { AgentToolResult, ExtensionAPI, Theme, ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { registerToolWithExecutor, getRegisteredToolExecutors } from "./lib/tool-executor-registry.ts";
import { capabilityConflict, getCapability, getCapabilityForTool, registerCapability, validateCapabilityArguments } from "./lib/capability-registry.ts";
import { executeBuiltinTool, nestedApprovalBlock, nestedSecurityBlock } from "./tool-caller.ts";
import { applyExtensionDefaults } from "./lib/themeMap.ts";
import { createOrchestrationRun, DEFAULT_ORCHESTRATION_TIMEOUT_MS, RunBudgetError } from "./lib/orchestration-run.ts";
import { coordinationState } from "./lib/coordination-state.ts";

const Step = Type.Object({
	tool: Type.String({ description: "Capability name, e.g. tasks or subagent_create" }),
	arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	label: Type.Optional(Type.String({ description: "Short label for the returned audit" })),
	retry: Type.Optional(Type.Integer({ minimum: 0, maximum: 3, description: "Retry transient executor errors up to this many times" })),
	timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 3_600_000, description: "Maximum time for one executor attempt; omit for 15 minutes, use 0 to disable" })),
	when: Type.Optional(Type.Object({
		step: Type.Integer({ minimum: 0, maximum: 15, description: "Prior step index to inspect" }),
		status: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("blocked"), Type.Literal("skipped")]),
	}, { description: "Only run when a prior sequential step has this status" })),
});

const ComposeParams = Type.Object({
	steps: Type.Optional(Type.Array(Step, { minItems: 1, maxItems: 16, description: "Steps to execute" })),
	parallel: Type.Optional(Type.Boolean({ description: "Run independent steps concurrently" })),
	stop_on_error: Type.Optional(Type.Boolean({ description: "Stop after the first failed step in sequential mode" })),
});

type StepArgs = { tool: string; arguments?: Record<string, unknown>; label?: string; retry?: number; timeout_ms?: number; when?: { step: number; status: "completed" | "failed" | "blocked" | "skipped" } };

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

/** Keep restart evidence useful without letting arbitrary tool details fill an event payload. */
function compactEventResult(value: any): unknown {
	const compact = compactResult(value);
	if (!compact || typeof compact !== "object") return compact;
	try {
		if (Buffer.byteLength(JSON.stringify(compact), "utf8") <= 8 * 1024) return compact;
	} catch { }
	const record = compact as Record<string, unknown>;
	const details = record.details && typeof record.details === "object" ? record.details as Record<string, unknown> : undefined;
	const safeDetails = details
		? Object.fromEntries(Object.entries(details).filter(([key, item]) => key === "path" || key === "outputFile" || ["string", "number", "boolean"].includes(typeof item)).slice(0, 24))
		: undefined;
	return {
		...(typeof record.text === "string" ? { text: record.text.slice(0, 4000) } : {}),
		...(safeDetails ? { details: safeDetails } : {}),
		truncated: true,
	};
}

class ComposeStepTimeoutError extends Error {
	readonly code = "COMPOSE_STEP_TIMEOUT";
}

class ComposeStepAbortedError extends Error {
	readonly code = "COMPOSE_STEP_ABORTED";
}

const BUILTIN_READ_SCHEMA = Type.Object({
	path: Type.String({ minLength: 1 }),
	offset: Type.Optional(Type.Integer({ minimum: 1 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
});

const BUILTIN_WRITE_SCHEMA = Type.Object({
	path: Type.String({ minLength: 1 }),
	content: Type.String(),
});

const BUILTIN_EDIT_SCHEMA = Type.Object({
	path: Type.String({ minLength: 1 }),
	oldText: Type.String({ minLength: 1 }),
	newText: Type.String(),
	replaceAll: Type.Optional(Type.Boolean()),
});

const BUILTIN_BASH_SCHEMA = Type.Object({
	command: Type.String({ minLength: 1, maxLength: 20000 }),
	timeout: Type.Optional(Type.Number({ minimum: 0, maximum: 600 })),
});

function registerBuiltinCapability(name: "read" | "write" | "edit" | "bash") {
	return name === "read"
		? registerCapability({ name, provider: "builtin", description: "Read a workspace file", inputSchema: BUILTIN_READ_SCHEMA, risk: "read", effect: { resources: ["workspace"], ordering: "commutative" }, execution: "in_process" })
		: name === "write"
			? registerCapability({ name, provider: "builtin", description: "Write a workspace file", inputSchema: BUILTIN_WRITE_SCHEMA, risk: "write", effect: { resources: ["workspace"], ordering: "ordered" }, execution: "in_process" })
			: name === "edit"
				? registerCapability({ name, provider: "builtin", description: "Edit a workspace file by exact text replacement", inputSchema: BUILTIN_EDIT_SCHEMA, risk: "write", effect: { resources: ["workspace"], ordering: "ordered" }, execution: "in_process" })
				: registerCapability({ name, provider: "builtin", description: "Run a security-checked workspace command", inputSchema: BUILTIN_BASH_SCHEMA, risk: "execute", effect: { resources: ["workspace", "shell"], ordering: "ordered" }, execution: "in_process" });
}

export default function(pi: ExtensionAPI) {
	registerToolWithExecutor(pi, {
		name: "compose_exec",
		label: "Compose Exec",
		description: "Run up to 16 registered extension capabilities as one bounded composition. Sequential steps may consume prior output with $STEP_n_TEXT or $STEP_n_DETAILS.path and use a safe when status condition. Use parallel=true only for independent steps. Workspace-bounded read/write/edit and security-checked bash are supported; other built-ins remain on Pi's native path.",
		parameters: ComposeParams,
		capabilityRisk: "execute",
		capabilityEffect: { resources: ["extension-runtime"], ordering: "unknown" },
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			let steps = (Array.isArray(params.steps) ? params.steps : []) as StepArgs[];
			const parallel = params.parallel === true;
			const stopOnError = params.stop_on_error !== false;
			const executors = getRegisteredToolExecutors();
			const cwd = ctx?.cwd || process.cwd();
			if (steps.length === 0) return { content: [{ type: "text" as const, text: "compose_exec requires steps" }], details: { error: "steps_required" } };
			const maxAttempts = steps.reduce((total, step) => total + 1 + Math.max(0, Math.min(step.retry ?? 0, 3)), 0);
			const run = createOrchestrationRun({ context: ctx, actor: "compose_exec", mode: coordinationState().mode, budget: { maxSteps: maxAttempts } });
			run.record("composition.started", { total: steps.length });
			const parallelConflict = parallel ? (() => {
				const capabilities = steps.map((step) => {
					const name = toolName(step.tool);
					if (name === "read" || name === "write" || name === "edit" || name === "bash") registerBuiltinCapability(name);
					return getCapability(`extensions.${name}`) ?? getCapabilityForTool(name);
				});
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
				const capability = name === "read" || name === "write" || name === "edit" || name === "bash"
					? registerBuiltinCapability(name)
					: getCapability(step.tool.startsWith("extensions.") ? step.tool : `extensions.${name}`) ?? getCapabilityForTool(name);
				const executor = executors[name] ?? (["read", "write", "edit", "bash"].includes(name)
					? ((_: string, args: Record<string, unknown>, signal: AbortSignal | undefined, __: unknown, context: any) => executeBuiltinTool(name, args, context, signal, pi))
					: undefined);
				if (!capability || !executor) return { index, tool: name, status: "blocked", error: "capability is not registered for in-process execution" };
				if (capability.execution !== "in_process") return { index, tool: name, status: "blocked", error: "capability is native-only; call it directly instead of composing it" };
				const resolvedArgs = resolveStepReferences(step.arguments ?? {}, priorResults, index);
				if (resolvedArgs.error) return { index, tool: name, status: "blocked", error: resolvedArgs.error };
				const args = (resolvedArgs.value ?? {}) as Record<string, unknown>;
				const schemaErrors = validateCapabilityArguments(capability, args);
				if (schemaErrors.length > 0) return { index, tool: name, status: "blocked", error: `invalid arguments: ${schemaErrors.join("; ")}` };
				const securityBlock = nestedSecurityBlock(name, args, cwd);
				if (securityBlock) return { index, tool: name, status: "blocked", error: `security: ${securityBlock}` };
				const approvalBlock = nestedApprovalBlock(name, args, cwd);
				if (approvalBlock) return { index, tool: name, status: "blocked", error: `approval: ${approvalBlock}` };
				const attempts = 1 + Math.max(0, Math.min(step.retry ?? 0, 3));
				for (let attempt = 1; attempt <= attempts; attempt += 1) {
					try {
						run.consumeStep();
						run.record("step.started", { index, tool: name, risk: capability.risk, parallel, attempt, maxAttempts: attempts });
						const stepTimeoutMs = step.timeout_ms === undefined ? DEFAULT_ORCHESTRATION_TIMEOUT_MS : step.timeout_ms;
						const controller = new AbortController();
						let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
						let abortListener: (() => void) | undefined;
						let rejectAbort: ((error: Error) => void) | undefined;
						const controlPromise = stepTimeoutMs > 0 || signal ? new Promise<never>((_, reject) => {
							rejectAbort = reject;
							if (stepTimeoutMs > 0) {
								timeoutTimer = setTimeout(() => {
									controller.abort();
									rejectAbort?.(new ComposeStepTimeoutError(`step timed out after ${stepTimeoutMs}ms`));
								}, stepTimeoutMs);
							}
						}) : undefined;
						if (signal) {
							abortListener = () => {
								controller.abort();
								rejectAbort?.(new ComposeStepAbortedError("step aborted by parent"));
							};
							if (signal.aborted) abortListener();
							else signal.addEventListener("abort", abortListener, { once: true });
						}
						try {
							const execution = executor(`${toolCallId}-compose-${index}-attempt-${attempt}`, args, controller.signal, onUpdate, ctx);
							const result = await (controlPromise ? Promise.race([execution, controlPromise]) : execution);
							run.record("step.completed", { index, tool: name, attempt, result: compactEventResult(result) });
							return { index, tool: name, status: "completed", attempts: attempt, result: compactResult(result), risk: capability.risk };
						} finally {
							if (timeoutTimer) clearTimeout(timeoutTimer);
							if (signal && abortListener) signal.removeEventListener("abort", abortListener);
						}
					} catch (error) {
						const message = error instanceof RunBudgetError ? `${error.message}; reduce steps or split the composition` : error instanceof Error ? error.message : String(error);
						if (!(error instanceof RunBudgetError) && !(error instanceof ComposeStepTimeoutError) && !(error instanceof ComposeStepAbortedError) && attempt < attempts) {
							run.record("step.retrying", { index, tool: name, attempt, nextAttempt: attempt + 1, error: message });
							continue;
						}
						run.record("step.failed", { index, tool: name, attempt, attempts: attempt, error: message });
						return { index, tool: name, status: "failed", attempts: attempt, error: message, risk: capability.risk };
					}
				}
			};

			const results: any[] = [];
			if (parallelConflict) {
				results.push(...steps.map((step, index) => ({ index, tool: toolName(step.tool), status: "blocked", error: `parallel effect conflict: ${parallelConflict}` })));
			} else if (parallel) {
				const parallelResults = await Promise.all(steps.map((step, index) => runStep(step, index, [])));
				parallelResults.forEach((result, index) => { results[index] = result; });
			}
			else {
				for (let index = 0; index < steps.length; index += 1) {
					const result = await runStep(steps[index]!, index, results);
					results.push(result);
					if (stopOnError && (result!.status === "failed" || result!.status === "blocked")) break;
				}
			}
			const failed = results.filter((result) => result.status === "failed" || result.status === "blocked").length;
			run.finish(failed ? "failed" : "succeeded", { total: steps.length, completed: results.length - failed, failed });
			return {
				content: [{ type: "text" as const, text: `compose_exec ${failed ? "completed with issues" : "completed"}: ${results.length}/${steps.length} step(s)` }],
				details: { runId: run.runId, parallel, total: steps.length, completed: results.filter((result) => result.status === "completed").length, failed, results },
			};
		},
		renderCall(args: Static<typeof ComposeParams>, theme: Theme) {
			return new Text(theme.fg("toolTitle", theme.bold("compose_exec ")) + theme.fg("accent", `${args.steps?.length ?? 0} step(s)${args.parallel ? " · parallel" : ""}`), 0, 0);
		},
		renderResult(result: AgentToolResult<unknown>, { expanded }: ToolRenderResultOptions, theme: Theme) {
			const details = result.details as any;
			const summary = `${details?.completed ?? 0}/${details?.total ?? 0} completed${details?.failed ? ` · ${details.failed} issue(s)` : ""}`;
			if (!expanded) return new Text(theme.fg(details?.failed ? "warning" : "success", summary), 0, 0);
			return new Text(theme.fg(details?.failed ? "warning" : "success", summary) + "\n" + theme.fg("muted", JSON.stringify(details?.results ?? [], null, 2)), 0, 0);
		},
	});

	pi.on("session_start", async (_event, ctx) => applyExtensionDefaults(import.meta.url, ctx));
}
