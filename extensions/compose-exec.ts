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
import { createOrchestrationRun, DEFAULT_ORCHESTRATION_TIMEOUT_MS, RunBudgetError } from "./lib/orchestration-run.ts";
import { coordinationState } from "./lib/coordination-state.ts";
import { listRunEvents, type RunEvent } from "./lib/evidence-store.ts";
import { summarizeOrchestrationRun } from "./lib/orchestration-query.ts";
import { dirname, join } from "node:path";

const Step = Type.Object({
	tool: Type.String({ description: "Capability name, e.g. tasks or dispatch_agent" }),
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
	steps: Type.Optional(Type.Array(Step, { minItems: 1, maxItems: 16, description: "Steps to execute; omitted only when resuming a persisted composition" })),
	parallel: Type.Optional(Type.Boolean({ description: "Run independent steps concurrently" })),
	stop_on_error: Type.Optional(Type.Boolean({ description: "Stop after the first failed step in sequential mode" })),
	resume_run_id: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9-]{1,128}$", description: "Explicitly resume a stale compose run by id" })),
});

type StepArgs = { tool: string; arguments?: Record<string, unknown>; label?: string; retry?: number; timeout_ms?: number; when?: { step: number; status: "completed" | "failed" | "blocked" | "skipped" } };

function eventData(event: RunEvent): Record<string, unknown> {
	if (!event.payload || typeof event.payload !== "object") return {};
	const payload = event.payload as Record<string, unknown>;
	return payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : payload;
}

function compositionEventDir(ctx: any, runId: string): string | undefined {
	const sessionFile = ctx?.sessionManager?.getSessionFile?.() || process.env.PI_SESSION_FILE;
	if (typeof sessionFile === "string" && sessionFile) return join(dirname(sessionFile), "compositions", runId);
	const cwd = ctx?.cwd;
	return typeof cwd === "string" && cwd ? join(cwd, ".pi", "agent-sessions", "compositions", runId) : undefined;
}

/** Keep a plan resumable without allowing one event to consume the whole journal. */
function boundedCompositionPlan(steps: StepArgs[]): StepArgs[] | undefined {
	try {
		const plan = steps.map((step) => ({ ...step, ...(step.arguments === undefined ? {} : { arguments: step.arguments }) }));
		return Buffer.byteLength(JSON.stringify(plan), "utf8") <= 48 * 1024 ? plan : undefined;
	} catch { return undefined; }
}

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
	} catch {}
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
		? registerCapability({ name, provider: "builtin", description: "Read a workspace file", inputSchema: BUILTIN_READ_SCHEMA, risk: "read", effect: { resources: ["workspace"], ordering: "commutative" } })
		: name === "write"
			? registerCapability({ name, provider: "builtin", description: "Write a workspace file", inputSchema: BUILTIN_WRITE_SCHEMA, risk: "write", effect: { resources: ["workspace"], ordering: "ordered" } })
			: name === "edit"
				? registerCapability({ name, provider: "builtin", description: "Edit a workspace file by exact text replacement", inputSchema: BUILTIN_EDIT_SCHEMA, risk: "write", effect: { resources: ["workspace"], ordering: "ordered" } })
				: registerCapability({ name, provider: "builtin", description: "Run a security-checked workspace command", inputSchema: BUILTIN_BASH_SCHEMA, risk: "execute", effect: { resources: ["workspace", "shell"], ordering: "ordered" } });
}

export default function (pi: ExtensionAPI) {
	registerToolWithExecutor(pi, {
		name: "compose_exec",
		label: "Compose Exec",
		description: "Run up to 16 registered extension capabilities as one bounded composition. Sequential steps may consume prior output with $STEP_n_TEXT or $STEP_n_DETAILS.path and use a safe when status condition. Use parallel=true only for independent steps. Workspace-bounded read/write/edit and security-checked bash are supported; other built-ins remain on Pi's native path. Use resume_run_id only for an explicit stale-run recovery.",
		parameters: ComposeParams,
		capabilityRisk: "execute",
		capabilityEffect: { resources: ["extension-runtime"], ordering: "unknown" },
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			let steps = (Array.isArray(params.steps) ? params.steps : []) as StepArgs[];
			const parallel = params.parallel === true;
			const stopOnError = params.stop_on_error !== false;
			const executors = getRegisteredToolExecutors();
			const cwd = ctx?.cwd || process.cwd();
			const requestedResumeId = typeof params.resume_run_id === "string" ? params.resume_run_id : undefined;
			let resumeOf: string | undefined;
			let reusedResults: any[] = [];
			if (requestedResumeId) {
				const sourceDir = compositionEventDir(ctx, requestedResumeId);
				const sourceEvents = sourceDir ? listRunEvents(sourceDir) : [];
				const sourceSummary = sourceDir ? summarizeOrchestrationRun(sourceDir) : undefined;
				const terminal = sourceEvents.some((event) => event.type === "run.succeeded" || event.type === "run.failed" || event.type === "run.cancelled");
				const started = sourceEvents.find((event) => event.type === "composition.started");
				const startedData = started ? eventData(started) : {};
				const persistedSteps = Array.isArray(startedData.steps) ? startedData.steps as StepArgs[] : undefined;
				if (terminal || sourceSummary?.status !== "stale") return { content: [{ type: "text" as const, text: "compose resume blocked: source run is not stale; inspect it before resuming" }], details: { error: terminal ? "resume_terminal" : "resume_source_active" } };
				if (!sourceDir || sourceEvents.length === 0 || !persistedSteps) return { content: [{ type: "text" as const, text: "compose resume blocked: source checkpoint is missing or not resumable" }], details: { error: "resume_checkpoint_missing" } };
				const completed = new Map<number, any>();
				for (const event of sourceEvents.filter((item) => item.type === "step.completed")) {
					const data = eventData(event);
					if (Number.isInteger(data.index) && data.result && typeof data.result === "object") completed.set(Number(data.index), { index: Number(data.index), tool: toolName(persistedSteps[Number(data.index)]?.tool || ""), status: "completed", result: data.result });
				}
				steps = persistedSteps;
				reusedResults = [...completed.values()].sort((a, b) => a.index - b.index);
				resumeOf = requestedResumeId;
			}
			if (steps.length === 0) return { content: [{ type: "text" as const, text: "compose_exec requires steps unless resume_run_id points to a resumable stale composition" }], details: { error: "steps_required" } };
			const maxAttempts = steps.reduce((total, step) => total + 1 + Math.max(0, Math.min(step.retry ?? 0, 3)), 0);
			const run = createOrchestrationRun({ context: ctx, actor: "compose_exec", mode: coordinationState().mode, budget: { maxSteps: maxAttempts }, workspaceCwd: cwd });
			if (resumeOf) run.record("composition.resumed", { sourceRunId: resumeOf, reusedSteps: reusedResults.map((result) => result.index) });
			const persistedPlan = boundedCompositionPlan(steps);
			run.record("composition.started", { steps: persistedPlan, resumable: Boolean(persistedPlan), total: steps.length });
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
			for (const result of reusedResults) results[result.index] = result;
			if (parallelConflict) {
				results.push(...steps.map((step, index) => ({ index, tool: toolName(step.tool), status: "blocked", error: `parallel effect conflict: ${parallelConflict}` })));
			} else if (parallel) {
				const parallelResults = await Promise.all(steps.map((step, index) => results[index]?.status === "completed" ? results[index] : runStep(step, index, [])));
				parallelResults.forEach((result, index) => { results[index] = result; });
			}
			else {
				for (let index = 0; index < steps.length; index += 1) {
					if (results[index]?.status === "completed") continue;
					const result = await runStep(steps[index]!, index, results);
					results.push(result);
					if (stopOnError && (result.status === "failed" || result.status === "blocked")) break;
				}
			}
			const failed = results.filter((result) => result.status === "failed" || result.status === "blocked").length;
			run.finish(failed ? "failed" : "succeeded", { total: steps.length, completed: results.length - failed, failed });
			return {
				content: [{ type: "text" as const, text: `compose_exec ${failed ? "completed with issues" : "completed"}: ${results.length}/${steps.length} step(s)` }],
				details: { runId: run.runId, eventDir: run.eventDir, ...(resumeOf ? { resumeOf, reusedSteps: reusedResults.map((result) => result.index) } : {}), parallel, total: steps.length, completed: results.filter((result) => result.status === "completed").length, failed, results },
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
