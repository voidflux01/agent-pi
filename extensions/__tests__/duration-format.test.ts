import { describe, expect, test } from "bun:test";
import { formatDuration } from "../lib/duration-format.ts";

describe("formatDuration", () => {
	test("under 1 minute renders as Ns", () => {
		expect(formatDuration(0)).toBe("0s");
		expect(formatDuration(999)).toBe("1s"); // rounds up
		expect(formatDuration(1_000)).toBe("1s");
		expect(formatDuration(30_000)).toBe("30s");
		expect(formatDuration(53_000)).toBe("53s");
	});

	test("at 1 minute renders as Nm Ns", () => {
		expect(formatDuration(59_999)).toBe("1m 0s"); // rounds up to 60s
		expect(formatDuration(60_000)).toBe("1m 0s");
		expect(formatDuration(72_000)).toBe("1m 12s");
	});

	test("longer durations keep minutes as the top unit", () => {
		expect(formatDuration(600_000)).toBe("10m 0s");
		expect(formatDuration(3_600_000)).toBe("60m 0s"); // no hour unit
	});

	test("negative input clamps to 0s", () => {
		expect(formatDuration(-5_000)).toBe("0s");
		expect(formatDuration(-1)).toBe("0s");
	});
});
