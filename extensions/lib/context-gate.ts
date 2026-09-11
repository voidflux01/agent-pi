// ABOUTME: Pure functions for context compaction gate — determines when to warn, prep, or force-compact.
// ABOUTME: Two-phase proactive compaction: prep at 70%, hard stop at 80%. Core framework handles actual compaction.

export const PREP_THRESHOLD = 70;
export const COMPACT_THRESHOLD = 80;

/** Session-scoped adaptive compaction thresholds. Feedback: post-compact usage. */
export interface ContextTuner {
	/** Warn/prep watermark; tightened when compactions leave the session tight, loosened when they free lots of headroom. */
	prep: number;
	/** Hard compact watermark; always at least GAP above prep. */
	compact: number;
}

export const CONTEXT_TUNER_STEP = 5;
/** Keep a minimum gap so prep and compact never fire on the same check. */
export const CONTEXT_TUNER_GAP = 5;
export const CONTEXT_TUNER_PREP_MIN = 50;
export const CONTEXT_TUNER_PREP_MAX = 85;
export const CONTEXT_TUNER_COMPACT_MIN = 60;
export const CONTEXT_TUNER_COMPACT_MAX = 95;
/** Matches the compaction card's color bands: >60% after a cycle means the session is still tight. */
export const CONTEXT_TUNER_TIGHT_BAND = 60;
/** ≤30% after a cycle means huge headroom was freed — the cycle could have waited. */
export const CONTEXT_TUNER_LOOSE_BAND = 30;

export function createContextTuner(): ContextTuner {
	return { prep: PREP_THRESHOLD, compact: COMPACT_THRESHOLD };
}

/** The session stayed hot after a cycle → both watermarks move earlier. */
export function tightenContextTuner(t: ContextTuner): void {
	t.prep = Math.max(CONTEXT_TUNER_PREP_MIN, t.prep - CONTEXT_TUNER_STEP);
	t.compact = Math.min(
		CONTEXT_TUNER_COMPACT_MAX,
		Math.max(t.compact - CONTEXT_TUNER_STEP, t.prep + CONTEXT_TUNER_GAP, CONTEXT_TUNER_COMPACT_MIN),
	);
}

/** The cycle freed huge headroom → both watermarks move later, less churn. */
export function loosenContextTuner(t: ContextTuner): void {
	t.prep = Math.min(CONTEXT_TUNER_PREP_MAX, t.prep + CONTEXT_TUNER_STEP);
	t.compact = Math.min(
		CONTEXT_TUNER_COMPACT_MAX,
		Math.max(t.compact + CONTEXT_TUNER_STEP, t.prep + CONTEXT_TUNER_GAP, CONTEXT_TUNER_COMPACT_MIN),
	);
}

/** One observation per completed compaction cycle. No-op in the neutral band. */
export function applyContextFeedback(t: ContextTuner, postPercent: number): void {
	if (postPercent > CONTEXT_TUNER_TIGHT_BAND) tightenContextTuner(t);
	else if (postPercent <= CONTEXT_TUNER_LOOSE_BAND) loosenContextTuner(t);
}

export interface CompactionGateResult {
	block: boolean;
	reason?: string;
	level: "ok" | "warn";
}

export type CompactionPhase = "ok" | "prep" | "compact";

export interface ProactiveCompactionResult {
	phase: CompactionPhase;
	percent: number;
}

/**
 * Check context usage and return warning status.
 * Never blocks — the core auto-compaction handles compaction properly
 * with auto_compaction_start/end events that trigger UI rebuild.
 */
export function shouldWarnForCompaction(percent: number | undefined, tuner?: ContextTuner): CompactionGateResult {
	if (percent == null) return { block: false, level: "ok" };
	if (percent >= (tuner?.prep ?? PREP_THRESHOLD)) return {
		block: false,
		level: "warn",
	};
	return { block: false, level: "ok" };
}

/**
 * Two-phase proactive compaction check:
 *   prep%+ → "prep"    — LLM should wrap up current work, commit progress
 *   compact%+ → "compact" — LLM must call cycle_memory immediately
 *   below  → "ok"      — no action needed
 */
export function getProactiveCompactionPhase(percent: number | undefined, tuner?: ContextTuner): ProactiveCompactionResult {
	const prep = tuner?.prep ?? PREP_THRESHOLD;
	const compact = tuner?.compact ?? COMPACT_THRESHOLD;
	if (percent == null) return { phase: "ok", percent: 0 };
	if (percent >= compact) return { phase: "compact", percent };
	if (percent >= prep) return { phase: "prep", percent };
	return { phase: "ok", percent };
}
