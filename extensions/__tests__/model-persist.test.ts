import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { persistModel } from "../lib/persist-model.ts";

describe("persistModel", () => {
	it("persists provider and model while preserving other settings", () => {
		const dir = mkdtempSync(join(tmpdir(), "model-persist-"));
		try {
			const path = join(dir, "settings.json");
			writeFileSync(path, JSON.stringify({ quietStartup: true, theme: "everforest" }));
			persistModel({ provider: "opencode-go", modelId: "deepseek-v4-flash" }, path);
			const settings = JSON.parse(readFileSync(path, "utf8"));
			expect(settings.defaultProvider).toBe("opencode-go");
			expect(settings.defaultModel).toBe("deepseek-v4-flash");
			expect(settings.quietStartup).toBe(true);
			expect(settings.theme).toBe("everforest");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fails clearly when the settings file is unavailable", () => {
		 expect(() => persistModel({ provider: "p", modelId: "m" }, "/missing/settings.json")).toThrow();
	});
});
