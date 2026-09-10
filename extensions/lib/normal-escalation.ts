// ABOUTME: Runtime guard that nudges coordination modes out of repeated read-only exploration.
// ABOUTME: Keeps new investigations flowing while requiring a bounded scout for stale loops.

import { isReconTool } from "./tool-classification.ts";
import { isReconBash } from "./tool-invocation.ts";

export const NORMAL_RECON_LIMIT = 8;
export const RECON_ESCALATION_LIMIT = NORMAL_RECON_LIMIT;

export interface NormalEscalationState {
	consecutiveReconCalls: number;
	totalReconCalls: number;
	lastReconFingerprint: string | null;
	sameTargetReconCalls: number;
	advisoryIssued: boolean;
}

export function createNormalEscalationState(): NormalEscalationState {
	return { consecutiveReconCalls: 0, totalReconCalls: 0, lastReconFingerprint: null, sameTargetReconCalls: 0, advisoryIssued: false };
}

export function resetNormalEscalation(state: NormalEscalationState): void {
	state.consecutiveReconCalls = 0;
	state.totalReconCalls = 0;
	state.lastReconFingerprint = null;
	state.sameTargetReconCalls = 0;
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

function stableValue(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return value.map(stableValue).join(",");
	if (typeof value === "object") {
		return Object.entries(value as Record<string, unknown>)
			.filter(([key]) => /^(?:path|file|file_path|query|pattern|glob|command|cmd|script|cwd|directory|root|line|offset|limit)$/i.test(key))
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${key}=${stableValue(item)}`)
			.join(";");
	}
	return String(value);
}

/** Stable, bounded identity for the repository target being inspected. */
export function reconFingerprint(toolName: string, args?: unknown): string {
	return `${toolName.toLowerCase()}:${stableValue(args).slice(0, 240)}`;
}

/**
 * Record one reconnaissance call. New targets remain available after the soft
 * threshold; only a repeated target is blocked as a stale exploration loop.
 */
export function recordNormalToolCall(
	state: NormalEscalationState,
	toolName: string,
	args?: unknown,
): { block: boolean; count: number; advisory: boolean; fingerprint: string } {
	if (!isNormalReconCall(toolName, args)) {
		resetNormalEscalation(state);
		return { block: false, count: 0, advisory: false, fingerprint: "" };
	}

	const fingerprint = reconFingerprint(toolName, args);
	state.consecutiveReconCalls++;
	state.totalReconCalls++;
	if (state.lastReconFingerprint === fingerprint) state.sameTargetReconCalls++;
	else state.sameTargetReconCalls = 1;
	state.lastReconFingerprint = fingerprint;
	const advisory = state.totalReconCalls >= NORMAL_RECON_LIMIT && !state.advisoryIssued;
	state.advisoryIssued ||= advisory;
	const block = state.totalReconCalls >= NORMAL_RECON_LIMIT && state.sameTargetReconCalls >= 2;
	return { block, count: state.consecutiveReconCalls, advisory, fingerprint };
}

export function normalEscalationReason(count: number): string {
	return `The same reconnaissance target has been repeated after the soft threshold (${count} calls). Dispatch one bounded read-only SCOUT with subagent_create (name: "scout"), or stop and report the verified terminal result. SCOUT output is evidence, not completion proof; continue in NORMAL if it resolves the uncertainty.`;
}

export function reconEscalationReason(mode: string, count: number): string {
	const normalized = String(mode || "NORMAL").toUpperCase();
	if (normalized === "NORMAL") return normalEscalationReason(count);
	return `${normalized} escalation: the same reconnaissance target has been repeated after the soft threshold (${count} calls). Dispatch one fresh bounded read-only SCOUT with subagent_create (name: "scout"), or stop and report the verified terminal result. Do not treat SCOUT output as completion proof.`;
}
