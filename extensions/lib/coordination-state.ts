// ABOUTME: Typed coordination state shared by mode, orchestration, and Commander extensions.
// ABOUTME: Keeps one global transport object while hiding its shape behind typed accessors.

import type { Mode } from "./mode-cycler-logic.ts";
import { resetGate, resolveGate } from "./commander-ready.ts";
import type { GateState, QueuedOp, ReadyGate } from "./commander-ready.ts";

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
	};
}

export function coordinationState(): CoordinationState {
	if (!globalState.__piCoordinationState) globalState.__piCoordinationState = createState();
	return globalState.__piCoordinationState;
}

export function setCoordinationMode(mode: Mode): void {
	coordinationState().mode = mode;
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
