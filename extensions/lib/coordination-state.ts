// ABOUTME: Typed coordination state shared by Pi modes and orchestration extensions.
// ABOUTME: Keeps one global state object while hiding its shape behind typed accessors.

import { resolve } from "node:path";
import type { Mode } from "./mode-cycler-logic.ts";
import type { AcceptanceContract } from "./execution-contract.ts";
import type { VerifierReceipt } from "./verifier-runtime.ts";

export interface VerificationSession {
	receipt?: VerifierReceipt;
	attempt: number;
	evalGate?: { ok: boolean; checkedAt: string; reason: string };
}

export interface WorkflowRunLink {
	cwd: string;
	runId: string;
}

export interface CoordinationState {
	mode: Mode;
	activeChain: string | null;
	activePipeline: string | null;
	/** PLAN implementation unlocked after show_plan approval. */
	planApproved: boolean;
	/** SPEC implementation unlocked after show_spec approval. */
	specApproved: boolean;
	/** The exact planning artifact snapshot approved by the user. */
	planApprovalBinding?: { filePath: string; fileFingerprint: string; contentFingerprint: string };
	/** The exact spec-folder snapshot approved by the user. */
	specApprovalBinding?: { folderPath: string; fileFingerprint: string; contentFingerprint: string };
	/** Current acceptance checklist bound to an approved plan or pipeline $PLAN. */
	executionContract?: AcceptanceContract;
	/** Exact workflow run owned by current Pi turn, scoped by workspace. */
	workflowRun?: WorkflowRunLink;
	/** Verifier state isolated by resolved workspace and contract fingerprint. */
	verificationSessions: Record<string, VerificationSession>;
}

interface CoordinationGlobal {
	__piCoordinationState?: CoordinationState;
}

const globalState = globalThis as typeof globalThis & CoordinationGlobal;

function createState(): CoordinationState {
	return {
		mode: "NORMAL",
		activeChain: null,
		activePipeline: null,
		planApproved: false,
		specApproved: false,
		planApprovalBinding: undefined,
		specApprovalBinding: undefined,
		executionContract: undefined,
		workflowRun: undefined,
		verificationSessions: Object.create(null),
	};
}

export function coordinationState(): CoordinationState {
	if (!globalState.__piCoordinationState) globalState.__piCoordinationState = createState();
	const state = globalState.__piCoordinationState;
	if (typeof state.planApproved !== "boolean") state.planApproved = false;
	if (typeof state.specApproved !== "boolean") state.specApproved = false;
	// Bindings were added after the boolean flags; keep old sessions readable.
	if (state.planApprovalBinding && typeof state.planApprovalBinding !== "object") state.planApprovalBinding = undefined;
	if (state.specApprovalBinding && typeof state.specApprovalBinding !== "object") state.specApprovalBinding = undefined;
	if (state.executionContract && typeof state.executionContract !== "object") state.executionContract = undefined;
	if (!state.verificationSessions || typeof state.verificationSessions !== "object") state.verificationSessions = Object.create(null);
	return state;
}

export function verificationScope(cwd: string, contractFingerprint: string): string {
	return `${resolve(cwd)}|${contractFingerprint}`;
}

function session(scope: string): VerificationSession {
	const state = coordinationState();
	return state.verificationSessions[scope] ||= { attempt: 0 };
}

export function setExecutionContract(contract: AcceptanceContract | undefined): void {
	coordinationState().executionContract = contract;
}

export function getExecutionContract(): AcceptanceContract | undefined {
	return coordinationState().executionContract;
}

export function setWorkflowRunLink(cwd: string, runId: string | undefined): void {
	const state = coordinationState();
	state.workflowRun = runId ? { cwd: resolve(cwd), runId } : undefined;
}

export function getWorkflowRunLink(cwd: string): WorkflowRunLink | undefined {
	const link = coordinationState().workflowRun;
	return link && link.cwd === resolve(cwd) ? link : undefined;
}

export function resetWorkflowRunLink(runId?: string): void {
	const state = coordinationState();
	if (!runId || state.workflowRun?.runId === runId) state.workflowRun = undefined;
}

export function setVerifierReceipt(receipt: VerifierReceipt | undefined, scope: string): void {
	const current = session(scope);
	if (receipt) {
		current.receipt = receipt;
		// A PASS closes the failure budget: the contract was met, so a later edit
		// that invalidates the receipt must start a fresh attempt lifecycle.
		// Without this, a PASS earned on the final allowed attempt locked every
		// subsequent re-verification behind the exhausted ceiling forever.
		if (receipt.status === "PASS") current.attempt = 0;
	} else delete current.receipt;
}

export function setEvalGate(gate: { ok: boolean; reason: string } | undefined, scope: string): void {
	const current = session(scope);
	if (gate) current.evalGate = { ok: gate.ok, checkedAt: new Date().toISOString(), reason: gate.reason };
	else delete current.evalGate;
}

export function getEvalGate(scope: string): { ok: boolean; checkedAt: string; reason: string } | undefined {
	return coordinationState().verificationSessions[scope]?.evalGate;
}

export function getVerifierReceipt(scope: string): VerifierReceipt | undefined {
	return coordinationState().verificationSessions[scope]?.receipt;
}

export function getVerifierAttempt(scope: string): number {
	return coordinationState().verificationSessions[scope]?.attempt || 0;
}

export function bumpVerifierAttempt(scope: string): number {
	const current = session(scope);
	current.attempt += 1;
	return current.attempt;
}

export function resetExecutionVerification(): void {
	const state = coordinationState();
	state.executionContract = undefined;
	state.verificationSessions = Object.create(null);
}

/** Live TUI ctx from `/mode` / set_mode so widgets hide on the visible UI. */
export type ModeChangeUi = { ui?: { setWidget: (key: string, renderer: unknown, options?: unknown) => void } };

type ModeChangeListener = (mode: Mode, previous: Mode, ctx?: ModeChangeUi) => void;
const modeChangeListeners = new Set<ModeChangeListener>();

/** Subscribe to mode changes. Returns an unsubscribe function. */
export function onCoordinationModeChange(listener: ModeChangeListener): () => void {
	modeChangeListeners.add(listener);
	return () => { modeChangeListeners.delete(listener); };
}

export function setCoordinationMode(mode: Mode, ctx?: ModeChangeUi): void {
	const previous = coordinationState().mode;
	coordinationState().mode = mode;
	if (previous === mode) return;
	for (const listener of modeChangeListeners) {
		try { listener(mode, previous, ctx); } catch { }
	}
}

export function setActiveChain(name: string | null): void {
	coordinationState().activeChain = name;
}

export function setActivePipeline(name: string | null): void {
	coordinationState().activePipeline = name;
}
