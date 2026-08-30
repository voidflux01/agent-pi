// ABOUTME: Typed coordination state shared by mode, orchestration, and Commander extensions.
// ABOUTME: Keeps one global transport object while hiding its shape behind typed accessors.

import type { Mode } from "./mode-cycler-logic.ts";
import { resetGate, resolveGate } from "./commander-ready.ts";
import type { GateState, QueuedOp, ReadyGate } from "./commander-ready.ts";
import type { AcceptanceContract } from "./execution-contract.ts";
import type { VerifierReceipt } from "./verifier-runtime.ts";

export interface CommanderClient {
	callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<any>;
}

export interface CommanderCoordinationState {
	state: GateState;
	gate?: ReadyGate;
	client?: CommanderClient;
	onReady: Array<() => void>;
}

export interface CoordinationState {
	mode: Mode;
	commander: CommanderCoordinationState;
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
	/** Isolated verifier receipt for the current contract fingerprint. */
	verifierReceipt?: VerifierReceipt;
	verifierAttempt?: number;
}

interface CoordinationGlobal {
	__piCoordinationState?: CoordinationState;
}

const globalState = globalThis as typeof globalThis & CoordinationGlobal;

function createState(): CoordinationState {
	return {
		mode: "NORMAL",
		commander: { state: "pending", onReady: [] },
		activeChain: null,
		activePipeline: null,
		planApproved: false,
		specApproved: false,
		planApprovalBinding: undefined,
		specApprovalBinding: undefined,
		executionContract: undefined,
		verifierReceipt: undefined,
		verifierAttempt: 0,
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
	if (state.verifierReceipt && typeof state.verifierReceipt !== "object") state.verifierReceipt = undefined;
	if (typeof state.verifierAttempt !== "number") state.verifierAttempt = 0;
	return state;
}

export function setExecutionContract(contract: AcceptanceContract | undefined): void {
	const state = coordinationState();
	const previousFingerprint = state.executionContract?.fingerprint;
	state.executionContract = contract;
	if (contract?.fingerprint !== previousFingerprint) {
		state.verifierReceipt = undefined;
		state.verifierAttempt = 0;
	}
}

export function getExecutionContract(): AcceptanceContract | undefined {
	return coordinationState().executionContract;
}

export function setVerifierReceipt(receipt: VerifierReceipt | undefined): void {
	coordinationState().verifierReceipt = receipt;
}

export function getVerifierReceipt(): VerifierReceipt | undefined {
	return coordinationState().verifierReceipt;
}

export function bumpVerifierAttempt(): number {
	const state = coordinationState();
	state.verifierAttempt = (state.verifierAttempt || 0) + 1;
	return state.verifierAttempt;
}

export function resetExecutionVerification(): void {
	const state = coordinationState();
	state.executionContract = undefined;
	state.verifierReceipt = undefined;
	state.verifierAttempt = 0;
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
		try { listener(mode, previous, ctx); } catch {}
	}
}

export function setActiveChain(name: string | null): void {
	coordinationState().activeChain = name;
}

export function setActivePipeline(name: string | null): void {
	coordinationState().activePipeline = name;
}

export function setCommanderGate(gate: ReadyGate): void {
	const commander = coordinationState().commander;
	commander.gate = gate;
	commander.state = gate.state;
}

export function setCommanderState(state: GateState): void {
	coordinationState().commander.state = state;
	if (coordinationState().commander.gate) coordinationState().commander.gate.state = state;
}

export function resolveCommanderGate(available: boolean): QueuedOp[] {
	const gate = commanderGate();
	if (!gate) {
		setCommanderState(available ? "available" : "unavailable");
		return [];
	}
	const queued = resolveGate(gate, available);
	setCommanderState(available ? "available" : "unavailable");
	return queued;
}

export function resetCommanderGate(): void {
	const gate = commanderGate();
	if (gate) resetGate(gate);
	setCommanderState("pending");
}

export function setCommanderClient(client: CommanderClient | undefined): void {
	coordinationState().commander.client = client;
}

export function commanderState(): CommanderCoordinationState {
	return coordinationState().commander;
}

export function commanderAvailable(): boolean {
	const commander = commanderState();
	return commander.state === "available" && !!commander.client;
}

export function commanderGate(): ReadyGate | undefined {
	return commanderState().gate;
}

export function commanderClient(): CommanderClient | undefined {
	return commanderState().client;
}

export function addCommanderReadyCallback(callback: () => void): void {
	commanderState().onReady.push(callback);
}

export function drainCommanderReadyCallbacks(): Array<() => void> {
	const callbacks = commanderState().onReady.splice(0);
	return callbacks;
}

/** Keep the queue type imported at the boundary so accidental shape drift is caught. */
export type { GateState, QueuedOp, ReadyGate };
