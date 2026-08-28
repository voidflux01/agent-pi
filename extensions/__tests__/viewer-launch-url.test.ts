// ABOUTME: Token-auth viewers must print the launch URL that actually loads.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { localViewerLaunch } from "../lib/viewer-session.ts";

const extDir = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("localViewerLaunch", () => {
	it("puts the capability token on the URL the browser and TUI should open", () => {
		const { url, launchUrl } = localViewerLaunch(59240, "abc+def");
		expect(url).toBe("http://127.0.0.1:59240");
		expect(launchUrl).toBe("http://127.0.0.1:59240/?token=abc%2Bdef");
	});
});

describe("token viewers advertise the launch URL", () => {
	const files = readdirSync(extDir)
		.filter((name) => name.endsWith(".ts") && !name.startsWith("."))
		.map((name) => ({ name, src: readFileSync(join(extDir, name), "utf8") }))
		.filter(({ src }) => src.includes("authorizeLocalServerRequest") && src.includes("launchUrl"));

	it("finds the authenticated viewers", () => {
		expect(files.map((f) => f.name).sort()).toEqual([
			"board-viewer.ts",
			"cleanup-viewer.ts",
			"completion-report.ts",
			"file-viewer.ts",
			"plan-viewer.ts",
			"reports-viewer.ts",
			"research-viewer.ts",
			"security-report.ts",
			"sounds.ts",
			"spec-viewer.ts",
		].sort());
	});

	it("puts launchUrl on the session or in the TUI notify", () => {
		for (const { name, src } of files) {
			const onSession = src.includes("launchUrl,") && src.includes("activeSession");
			const onNotify = src.includes("${launchUrl}") || src.includes("session.launchUrl");
			expect(onSession || onNotify, `${name} must expose launchUrl`).toBe(true);
		}
	});
});
