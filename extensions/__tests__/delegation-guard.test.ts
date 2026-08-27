// ABOUTME: Tests for probeNestedPiLaunch - flags bash commands that would
// ABOUTME spawn headless pi outside the team dispatch tools (shadow fleets).

import { describe, it, expect } from "vitest";
import { probeNestedPiLaunch } from "../lib/delegation-guard.ts";

describe("probeNestedPiLaunch", () => {
	it("flags headless pi invocations", () => {
		expect(probeNestedPiLaunch('pi --mode json -p "do the thing"')).toBe(true);
		expect(probeNestedPiLaunch("pi -p 'summarize README'")).toBe(true);
		expect(probeNestedPiLaunch("cd /tmp && pi -p hi")).toBe(true);
		expect(probeNestedPiLaunch("./node_modules/.bin/pi -p hi")).toBe(true);
		expect(probeNestedPiLaunch("pi --mode json task.txt")).toBe(true);
	});

	it("ignores lookalikes and interactive launches", () => {
		expect(probeNestedPiLaunch("pip install pillow")).toBe(false);
		expect(probeNestedPiLaunch("echo pi -p is a flag")).toBe(true); // conservative: token match wins
		expect(probeNestedPiLaunch("grep pi file.txt")).toBe(false);
		expect(probeNestedPiLaunch("pi")).toBe(false); // interactive pane is visible work
		expect(probeNestedPiLaunch("")).toBe(false);
	});
});
