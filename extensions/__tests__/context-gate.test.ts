// ABOUTME: Tests for context compaction gate — threshold logic for warning and proactive compaction.
// ABOUTME: Covers ok/warn/prep/compact levels and boundary conditions.

import { describe, it, expect } from "vitest";
import {
	shouldWarnForCompaction,
	getProactiveCompactionPhase,
	PREP_THRESHOLD,
	COMPACT_THRESHOLD,
	createContextTuner,
	applyContextFeedback,
	tightenContextTuner,
	loosenContextTuner,
} from "../lib/context-gate.ts";

describe("shouldWarnForCompaction", () => {
	it("should return ok when percent is undefined", () => {
		const result = shouldWarnForCompaction(undefined);
		expect(result).toEqual({ block: false, level: "ok" });
	});

	it("should return ok below PREP_THRESHOLD", () => {
		expect(shouldWarnForCompaction(0).level).toBe("ok");
		expect(shouldWarnForCompaction(50).level).toBe("ok");
		expect(shouldWarnForCompaction(69).level).toBe("ok");
		expect(shouldWarnForCompaction(69).block).toBe(false);
	});

	it("should return warn at PREP_THRESHOLD (70%)", () => {
		const result = shouldWarnForCompaction(PREP_THRESHOLD);
		expect(result.level).toBe("warn");
		expect(result.block).toBe(false);
	});

	it("should return warn above 70%", () => {
		expect(shouldWarnForCompaction(75).level).toBe("warn");
		expect(shouldWarnForCompaction(80).level).toBe("warn");
		expect(shouldWarnForCompaction(95).level).toBe("warn");
	});

	it("should never block — core handles compaction", () => {
		expect(shouldWarnForCompaction(90).block).toBe(false);
		expect(shouldWarnForCompaction(95).block).toBe(false);
		expect(shouldWarnForCompaction(99).block).toBe(false);
	});
});

describe("getProactiveCompactionPhase", () => {
	it("should return ok when percent is undefined", () => {
		const result = getProactiveCompactionPhase(undefined);
		expect(result).toEqual({ phase: "ok", percent: 0 });
	});

	it("should return ok below 70%", () => {
		expect(getProactiveCompactionPhase(0).phase).toBe("ok");
		expect(getProactiveCompactionPhase(50).phase).toBe("ok");
		expect(getProactiveCompactionPhase(69).phase).toBe("ok");
		expect(getProactiveCompactionPhase(69.9).phase).toBe("ok");
	});

	it("should return prep at exactly 70%", () => {
		const result = getProactiveCompactionPhase(70);
		expect(result.phase).toBe("prep");
		expect(result.percent).toBe(70);
	});

	it("should return prep between 70-79%", () => {
		expect(getProactiveCompactionPhase(71).phase).toBe("prep");
		expect(getProactiveCompactionPhase(75).phase).toBe("prep");
		expect(getProactiveCompactionPhase(79).phase).toBe("prep");
		expect(getProactiveCompactionPhase(79.9).phase).toBe("prep");
	});

	it("should return compact at exactly 80%", () => {
		const result = getProactiveCompactionPhase(80);
		expect(result.phase).toBe("compact");
		expect(result.percent).toBe(80);
	});

	it("should return compact above 80%", () => {
		expect(getProactiveCompactionPhase(85).phase).toBe("compact");
		expect(getProactiveCompactionPhase(90).phase).toBe("compact");
		expect(getProactiveCompactionPhase(95).phase).toBe("compact");
		expect(getProactiveCompactionPhase(100).phase).toBe("compact");
	});

	it("should preserve percent in result", () => {
		expect(getProactiveCompactionPhase(42).percent).toBe(42);
		expect(getProactiveCompactionPhase(73.5).percent).toBe(73.5);
		expect(getProactiveCompactionPhase(88).percent).toBe(88);
	});
});

describe("threshold constants", () => {
	it("PREP_THRESHOLD should be 70", () => {
		expect(PREP_THRESHOLD).toBe(70);
	});

	it("COMPACT_THRESHOLD should be 80", () => {
		expect(COMPACT_THRESHOLD).toBe(80);
	});
});

describe("ContextTuner adaptive feedback", () => {
	it("starts at the static defaults", () => {
		expect(createContextTuner()).toEqual({ prep: PREP_THRESHOLD, compact: COMPACT_THRESHOLD });
	});

	it("tightens when a compaction leaves the session hot", () => {
		const tuner = createContextTuner();
		applyContextFeedback(tuner, 65);
		expect(tuner).toEqual({ prep: 65, compact: 75 });
		// Neutral band (31-60) is a no-op.
		applyContextFeedback(tuner, 40);
		expect(tuner).toEqual({ prep: 65, compact: 75 });
	});

	it("loosens when a compaction frees huge headroom", () => {
		const tuner = createContextTuner();
		applyContextFeedback(tuner, 25);
		expect(tuner).toEqual({ prep: 75, compact: 85 });
		// Band boundary: >60 tightens, 31-60 neutral, ≤30 loosens.
		const t2 = createContextTuner();
		applyContextFeedback(t2, 60);
		expect(t2).toEqual({ prep: 70, compact: 80 });
		applyContextFeedback(t2, 30);
		expect(t2).toEqual({ prep: 75, compact: 85 });
	});

	it("clamps at safe floors and ceilings", () => {
		const tight = createContextTuner();
		for (let i = 0; i < 10; i++) tightenContextTuner(tight);
		expect(tight.prep).toBe(50);
		expect(tight.compact).toBe(60);

		const loose = createContextTuner();
		for (let i = 0; i < 10; i++) loosenContextTuner(loose);
		expect(loose.prep).toBe(85);
		expect(loose.compact).toBe(95);
	});

	it("keeps compact at least GAP above prep", () => {
		const tight = { prep: 65, compact: 66 };
		tightenContextTuner(tight);
		expect(tight.prep).toBe(60);
		expect(tight.compact).toBe(65);
		expect(tight.compact - tight.prep).toBeGreaterThanOrEqual(5);

		const loose = { prep: 80, compact: 80 };
		loosenContextTuner(loose);
		expect(loose.prep).toBe(85);
		expect(loose.compact).toBe(90);
		expect(loose.compact - loose.prep).toBeGreaterThanOrEqual(5);
	});

	it("phase checks honor a tuner while keeping defaults untouched", () => {
		const tuner = { prep: 65, compact: 75 };
		expect(getProactiveCompactionPhase(76, tuner).phase).toBe("compact");
		expect(getProactiveCompactionPhase(70, tuner).phase).toBe("prep");
		expect(getProactiveCompactionPhase(60, tuner).phase).toBe("ok");
		expect(shouldWarnForCompaction(70, tuner).level).toBe("warn");
		expect(shouldWarnForCompaction(60, tuner).level).toBe("ok");
		// Static behavior unchanged when no tuner is supplied.
		expect(getProactiveCompactionPhase(72).phase).toBe("prep");
		expect(shouldWarnForCompaction(72).level).toBe("warn");
	});
});
