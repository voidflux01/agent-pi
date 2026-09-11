// ABOUTME: Runtime guard that nudges coordination modes out of repeated read-only exploration.
// ABOUTME: Keeps new investigations flowing while requiring a bounded scout for stale loops.

import { isReconTool } from "./tool-classification.ts";
import { isReconBash } from "./tool-invocation.ts";

/** Soft nudge threshold: aligns with the prompt's "3-5 focused inspection calls" rule. */
export const NORMAL_RECON_LIMIT = 4;
/** Hard stop ceiling: restores the pre-2026-09 consecutive-count block. */
export const NORMAL_RECON_BLOCK_LIMIT = 8;

/** Session-scoped adaptive thresholds, reset on mode/session change, never on a request burst. */
export interface NormalTuner {
	/** Advisory threshold: lowered when the model picks a scout, raised when the nudge was noise. */
	soft: number;
	/** Hard stall threshold: lowered only when the block actually fires. */
	block: number;
}

export const TUNER_SOFT_MIN = 2;
export const TUNER_BLOCK_MIN = 4;
export const TUNER_BLOCK_MAX = 8;

export function createNormalTuner(): NormalTuner {
	return { soft: NORMAL_RECON_LIMIT, block: NORMAL_RECON_BLOCK_LIMIT };
}

/** The model chose a scout after an advisory → nudge earlier next burst. */
export function softenTuner(t: NormalTuner): void {
	t.soft = Math.max(TUNER_SOFT_MIN, t.soft - 1);
}

/** The model acted without a scout after an advisory → the nudge was noise, fire later. Never above the block threshold. */
export function hardenTuner(t: NormalTuner): void {
	t.soft = Math.min(t.block, t.soft + 1);
}

/** A stale read loop hit the hard block → both thresholds tighten so the next burst gives up earlier. */
export function stallTuner(t: NormalTuner): void {
	t.block = Math.max(TUNER_BLOCK_MIN, t.block - 1);
	t.soft = Math.max(TUNER_SOFT_MIN, Math.min(t.soft, t.block) - 1);
}

/** True when a tool call dispatches a scout (the actionable follow-up to an advisory). */
export function isScoutDispatch(toolName: string, args?: unknown): boolean {
	if (toolName === "subagent_create") return (args as any)?.name === "scout";
	if (toolName === "subagent_create_batch") {
		const agents = (args as any)?.agents;
		return Array.isArray(agents) && agents.some((a: any) => a?.name === "scout");
	}
	return false;
}

export interface NormalEscalationState {
	consecutiveReconCalls: number;
	advisoryIssued: boolean;
}

export function createNormalEscalationState(): NormalEscalationState {
	return { consecutiveReconCalls: 0, advisoryIssued: false };
}

export function resetNormalEscalation(state: NormalEscalationState): void {
	state.consecutiveReconCalls = 0;
	state.advisoryIssued = false;
}

export function isNormalReconTool(toolName: string): boolean {
	return isReconTool(toolName);
}

/** Conservative classification for shell-based repository reconnaissance. */
export function isNormalReconCall(toolName: string, args?: unknown): boolean {
	if (isNormalReconTool(toolName)) return true;
	if (toolName !== "bash") return false;
	return isReconBash(args);
}

/**
 * Record one reconnaissance call. Crossing the soft limit issues the advisory
 * once; crossing the hard ceiling blocks a stalled read-only run regardless of
 * whether the target changed.
 */
export function recordNormalToolCall(
	state: NormalEscalationState,
	tuner: NormalTuner,
	toolName: string,
	args?: unknown,
): { block: boolean; count: number; advisory: boolean } {
	if (!isNormalReconCall(toolName, args)) {
		resetNormalEscalation(state);
		return { block: false, count: 0, advisory: false };
	}

	state.consecutiveReconCalls++;
	const advisory = state.consecutiveReconCalls >= tuner.soft && !state.advisoryIssued;
	state.advisoryIssued ||= advisory;
	const block = state.consecutiveReconCalls >= tuner.block;
	return { block, count: state.consecutiveReconCalls, advisory };
}

export function normalEscalationReason(count: number): string {
	return `${count} consecutive read-only inspection calls without a terminal result. Dispatch one bounded read-only SCOUT with subagent_create (name: "scout"), or stop and report the verified terminal result. SCOUT output is evidence, not completion proof; continue in NORMAL if it resolves the uncertainty.`;
}

/**
 * One-time soft reminder issued once per reconnaissance burst. Advisory only:
 * it never blocks a call and never forces a mode switch.
 */
export function reconEscalationAdvisory(mode: string, count: number): string {
	const normalized = String(mode || "NORMAL").toUpperCase();
	return `${normalized} advisory (${count} read-only inspection calls): do not open another read-only call. Either the context is resolved — report the verified terminal result and proceed — or it is not — dispatch one bounded read-only SCOUT with subagent_create (name: "scout") for an independent look. SCOUT output is evidence, not completion proof.`;
}

export function reconEscalationReason(mode: string, count: number): string {
	const normalized = String(mode || "NORMAL").toUpperCase();
	if (normalized === "NORMAL") return normalEscalationReason(count);
	return `${normalized} escalation: ${count} consecutive read-only inspection calls without a terminal result. Dispatch one fresh bounded read-only SCOUT with subagent_create (name: "scout"), or stop and report the verified terminal result. Do not treat SCOUT output as completion proof.`;
}
