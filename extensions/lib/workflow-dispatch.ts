// ABOUTME: Shared lifecycle hook for the canonical subagent_create dispatcher.
// ABOUTME: Mode-owned workflows validate dispatches and consume results here.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type WorkflowMode = "NORMAL" | "TEAM" | "PIPELINE" | "CHAIN";

export interface DispatchContext {
	mode: WorkflowMode;
	runId?: string;
	phase?: string;
	phaseIndex?: number;
	stepIndex?: number;
	scope?: string;
}

export type DispatchReceiptStatus = "pending" | "done" | "error" | "cancelled" | "consumed";

export interface DispatchReceipt {
	version: 1;
	id: string;
	createdAt: number;
	updatedAt: number;
	status: DispatchReceiptStatus;
	name: string;
	task: string;
	batch: boolean;
	context: DispatchContext;
	exitCode?: number;
	elapsedMs?: number;
	outputFile?: string;
	evidenceRefs: string[];
	error?: string;
}

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
	context?: DispatchContext;
	receiptId?: string;
	elapsedMs?: number;
	evidenceRefs?: string[];
}

export interface WorkflowDispatchHook {
	before?: (input: { name: string; task: string; batch: boolean }) => string | undefined;
	context?: (input: { name: string; task: string; batch: boolean }) => Partial<DispatchContext> | undefined;
	after?: (result: WorkflowDispatchResult) => void;
}

export type ApprovalWorkflowMode = "PLAN" | "SPEC";
export interface WorkflowApprovalResult {
	mode: ApprovalWorkflowMode;
	action: "approved" | "reset";
	path?: string;
	fileFingerprint?: string;
	contentFingerprint?: string;
}
export interface WorkflowApprovalHook {
	after?: (result: WorkflowApprovalResult) => void;
}

const hookStore = globalThis as typeof globalThis & {
	__agentPiWorkflowDispatchHooks?: Map<WorkflowMode, WorkflowDispatchHook>;
	__agentPiWorkflowApprovalHooks?: Map<ApprovalWorkflowMode, WorkflowApprovalHook>;
};
const hooks = hookStore.__agentPiWorkflowDispatchHooks ??= new Map<WorkflowMode, WorkflowDispatchHook>();
const approvalHooks = hookStore.__agentPiWorkflowApprovalHooks ??= new Map<ApprovalWorkflowMode, WorkflowApprovalHook>();

export function registerWorkflowDispatchHook(mode: WorkflowMode, hook: WorkflowDispatchHook): void {
	hooks.set(mode, hook);
}

export function registerWorkflowApprovalHook(mode: ApprovalWorkflowMode, hook: WorkflowApprovalHook): void {
	approvalHooks.set(mode, hook);
}

export function workflowApprovalAfter(result: WorkflowApprovalResult): void {
	approvalHooks.get(result.mode)?.after?.(result);
}

export function workflowDispatchBefore(mode: string, input: { name: string; task: string; batch: boolean }): string | undefined {
	return hooks.get(mode as WorkflowMode)?.before?.(input);
}

export function workflowDispatchContext(mode: string, input: { name: string; task: string; batch: boolean }): DispatchContext {
	const normalized = (mode || "NORMAL").toUpperCase() as WorkflowMode;
	return { mode: normalized, ...(hooks.get(normalized)?.context?.(input) || {}) };
}

export function workflowDispatchAfter(result: WorkflowDispatchResult): void {
	hooks.get(result.mode)?.after?.(result);
}

function receiptDir(cwd: string): string {
	return join(cwd, ".pi", "agent-sessions", "dispatch-receipts");
}

const RECEIPT_ID_PATTERN = /^[a-zA-Z0-9-]{1,120}$/;

function receiptPath(cwd: string, id: string): string {
	if (!RECEIPT_ID_PATTERN.test(id)) throw new Error("Invalid receipt id");
	return join(receiptDir(cwd), `${id}.json`);
}

function atomicWrite(path: string, value: unknown): void {
	const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
	renameSync(tmp, path);
}

export function createDispatchReceipt(
	cwd: string,
	context: DispatchContext,
	name: string,
	task: string,
	batch: boolean,
): DispatchReceipt {
	mkdirSync(receiptDir(cwd), { recursive: true, mode: 0o700 });
	const now = Date.now();
	const receipt: DispatchReceipt = {
		version: 1,
		id: `${context.mode.toLowerCase()}-${randomUUID()}`,
		createdAt: now,
		updatedAt: now,
		status: "pending",
		name: name.slice(0, 120),
		task: task.slice(0, 4_000),
		batch,
		context,
		evidenceRefs: [],
	};
	atomicWrite(receiptPath(cwd, receipt.id), receipt);
	return receipt;
}

export function finishDispatchReceipt(
	cwd: string,
	id: string,
	result: Pick<WorkflowDispatchResult, "status" | "exitCode" | "fullOutputPath" | "elapsedMs" | "evidenceRefs"> & { context?: DispatchContext; error?: string },
): DispatchReceipt | undefined {
	let path: string;
	try { path = receiptPath(cwd, id); } catch { return undefined; }
	if (!existsSync(path)) return undefined;
	let receipt: DispatchReceipt;
	try { receipt = JSON.parse(readFileSync(path, "utf8")) as DispatchReceipt; } catch { return undefined; }
	receipt.status = result.status === "done" ? "done" : "error";
	if (result.context) receipt.context = { ...receipt.context, ...result.context };
	receipt.exitCode = result.exitCode;
	receipt.elapsedMs = result.elapsedMs;
	receipt.outputFile = result.fullOutputPath || undefined;
	receipt.evidenceRefs = (result.evidenceRefs || []).slice(0, 32);
	receipt.error = result.error?.slice(0, 500);
	receipt.updatedAt = Date.now();
	atomicWrite(path, receipt);
	return receipt;
}

export function readDispatchReceipt(cwd: string, id: string): DispatchReceipt | undefined {
	try {
		const receipt = JSON.parse(readFileSync(receiptPath(cwd, id), "utf8")) as DispatchReceipt;
		return receipt.version === 1 && receipt.id === id ? receipt : undefined;
	} catch { return undefined; }
}

export function consumeDispatchReceipt(cwd: string, id: string): DispatchReceipt | undefined {
	const receipt = readDispatchReceipt(cwd, id);
	if (!receipt || (receipt.status !== "done" && receipt.status !== "error")) return undefined;
	receipt.status = "consumed";
	receipt.updatedAt = Date.now();
	atomicWrite(receiptPath(cwd, id), receipt);
	return receipt;
}
