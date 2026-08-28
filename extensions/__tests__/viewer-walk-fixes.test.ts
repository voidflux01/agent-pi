// ABOUTME: Guards the walk-through bugs: grill ctx, default-off grill, mode abort.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const extDir = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("grill tools bind the execute context", () => {
	const src = readFileSync(join(extDir, "plan-viewer.ts"), "utf8");

	it("does not read a missing ctx.cwd from grill handlers", () => {
		expect(src).toContain("recordGrillTurn(ctx2.cwd");
		expect(src).toContain("saveGrillResults(ctx2.cwd");
		expect(src).toContain("armGrillSession(ctx2.cwd");
		expect(src).not.toMatch(/recordGrillTurn\(ctx\.cwd/);
		expect(src).not.toMatch(/saveGrillResults\(ctx\.cwd/);
	});

	it("does not auto-arm grill-me on show_plan", () => {
		expect(src).toContain("params.grill === true");
		expect(src).not.toContain("params.grill !== false");
	});

	it("does not tell the model to implement while grill is unfinished", () => {
		expect(src).toContain("Do not implement yet.");
	});
});
