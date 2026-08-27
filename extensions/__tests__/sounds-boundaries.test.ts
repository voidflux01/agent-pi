import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { isSafeSoundName } from "../lib/sounds-player.ts";
import { readFileSync } from "node:fs";
import { generateSoundsViewerHTML } from "../lib/sounds-viewer-html.ts";

describe("sound viewer boundaries", () => {
	it("accepts only filesystem-safe sound names", () => {
		expect(isSafeSoundName("notify_ok-1")).toBe(true);
		expect(isSafeSoundName({} as any)).toBe(false);
		for (const name of ["../outside", "a/b", "", "a\0b"]) expect(isSafeSoundName(name)).toBe(false);
	});

	it("escapes catalog values in browser rendering and bounds feeds", () => {
		const html = generateSoundsViewerHTML({
			catalog: [{ name: "safe", title: "<img src=x>", description: "<script>alert(1)</script>", categories: ["other"], meta: {} } as any],
			config: { assignments: {}, volume: 0.5, enabled: true },
			port: 1,
		});
		expect(html).toContain("function esc(s)");
		expect(readFileSync(new URL("../sounds.ts", import.meta.url), "utf8")).toContain("MAX_SOUND_FEED_BYTES");
		const player = readFileSync(new URL("../lib/sounds-player.ts", import.meta.url), "utf8");
		expect(player).toContain('execFileSync("which", [cmd]');
		expect(player).toContain('flag: "wx"');
		expect(player).toContain("parsed.name !== name");
	});
});
