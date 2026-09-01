// ABOUTME: Per-extension default theme assignments mapping extension filenames to themes.
// ABOUTME: Each extension calls applyExtensionDefaults() in session_start to load its theme.
/**
 * themeMap.ts — Per-extension default theme assignments
 *
 * Themes live in .pi/themes/ and are mapped by extension filename (no extension).
 * Each extension calls applyExtensionTheme(import.meta.url, ctx) in its session_start
 * hook to automatically load its designated theme on boot.
 *
 * Available themes (.pi/themes/):
 *   monochrome-blue
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { basename } from "path";
import { fileURLToPath } from "url";

// ── Theme assignments ──────────────────────────────────────────────────────
//
// Key   = extension filename without extension (matches extensions/<key>.ts)
// Value = theme name from .pi/themes/<value>.json
//
export const THEME_MAP: Record<string, string> = {
	"agent-banner": "terminal-paper", "agent-chain": "terminal-paper", "agent-team": "terminal-paper",
	"cross-agent": "terminal-paper", "damage-control": "terminal-paper", "minimal": "terminal-paper",
	"pi-pi": "terminal-paper", "pure-focus": "terminal-paper", "purpose-gate": "terminal-paper",
	"session-replay": "terminal-paper", "subagent-widget": "terminal-paper", "system-select": "terminal-paper",
	"theme-cycler": "terminal-paper", "mic": "terminal-paper", "pipeline-team": "terminal-paper",
	"tasks": "terminal-paper", "plan-mode": "terminal-paper", "tool-counter": "terminal-paper",
	"tool-counter-widget": "terminal-paper", "footer": "terminal-paper", "mode-cycler": "terminal-paper",
	"user-question": "terminal-paper", "plan-viewer": "terminal-paper", "completion-report": "terminal-paper",
	"sounds": "terminal-paper",
};

// ── Helpers ───────────────────────────────────────────────────────────────

/** Derive the extension name (e.g. "minimal") from its import.meta.url. */
function extensionName(fileUrl: string): string {
	const filePath = fileUrl.startsWith("file://") ? fileURLToPath(fileUrl) : fileUrl;
	return basename(filePath).replace(/\.[^.]+$/, "");
}

// ── Theme ──────────────────────────────────────────────────────────────────

/**
 * Apply the mapped theme for an extension on session boot.
 *
 * @param fileUrl   Pass `import.meta.url` from the calling extension file.
 * @param ctx       The ExtensionContext from the session_start handler.
 * @returns         true if the theme was applied successfully, false otherwise.
 */
export function applyExtensionTheme(fileUrl: string, ctx: ExtensionContext): boolean {
	if (!ctx.hasUI) return false;

	const name = extensionName(fileUrl);
	
	// If there are multiple extensions stacked in 'ipi', they each fire session_start
	// and try to apply their own mapped theme. The LAST one to fire wins.
	// Since system-select is last in the ipi alias array, it was setting 'catppuccin-mocha'.
	
	// We want to skip theme application for all secondary extensions if they are stacked,
	// so the primary extension (first in the array) dictates the theme.
	const primaryExt = primaryExtensionName();
	if (primaryExt && primaryExt !== name) {
		return true; // Pretend we succeeded, but don't overwrite the primary theme
	}

	// Respect a user-selected theme: if the current theme is already a real
	// named theme (not Pi's initial dark/light/auto detection), don't override
	// it on every session start. This keeps /theme and ctrl+x/q changes
	// persistent across restarts.
	const currentTheme = ctx.ui.theme?.name;
	if (currentTheme && currentTheme !== "dark" && currentTheme !== "light" && currentTheme !== "auto") {
		return true;
	}

	let themeName = THEME_MAP[name];
	
	if (!themeName) {
		themeName = "midnight-ocean";
	}

	const result = ctx.ui.setTheme(themeName);

	if (!result.success && themeName !== "midnight-ocean") {
		return ctx.ui.setTheme("midnight-ocean").success;
	}
	
	return result.success;
}
// ── Title ──────────────────────────────────────────────────────────────────

/**
 * Read process.argv to find the first -e / --extension flag value.
 *
 * When Pi is launched as:
 *   pi -e extensions/subagent-widget.ts -e extensions/pure-focus.ts
 *
 * process.argv contains those paths verbatim. Every stacked extension calls
 * this and gets the same answer ("subagent-widget"), so all setTitle calls
 * are idempotent — no shared state or deduplication needed.
 *
 * Returns null if no -e flag is present (e.g. plain `pi` with no extensions).
 */
function primaryExtensionName(argv: string[] = process.argv): string | null {
	for (let i = 0; i < argv.length - 1; i++) {
		if (argv[i] === "-e" || argv[i] === "--extension") {
			return basename(argv[i + 1]).replace(/\.[^.]+$/, "");
		}
	}
	return null;
}

/**
 * Visible OSC title. Subagent panes pass PI_PANE_TITLE so herdr shows the
 * role (scout-sa1) instead of the first stacked extension (security-guard).
 */
export function extensionTerminalTitle(
	argv: string[] = process.argv,
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	const pane = env.PI_PANE_TITLE?.trim();
	if (pane) return `π - ${pane}`;
	if (env.PI_SUBAGENT === "1") {
		const agent = env.PI_AGENT_NAME?.trim();
		if (agent) return `π - ${agent}`;
	}
	const name = primaryExtensionName(argv);
	return name ? `π - ${name}` : null;
}

/**
 * Set the terminal title on session boot.
 * Deferred 150 ms to fire after Pi's own startup title-set.
 */
function applyExtensionTitle(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const title = extensionTerminalTitle();
	if (!title) return;
	setTimeout(() => ctx.ui.setTitle(title), 150);
}

// ── Combined default ───────────────────────────────────────────────────────

/**
 * Apply both the mapped theme AND the terminal title for an extension.
 * Drop-in replacement for applyExtensionTheme — call this in every session_start.
 *
 * Usage:
 *   import { applyExtensionDefaults } from "./themeMap.ts";
 *
 *   pi.on("session_start", async (_event, ctx) => {
 *     applyExtensionDefaults(import.meta.url, ctx);
 *     // ... rest of handler
 *   });
 */
export function applyExtensionDefaults(fileUrl: string, ctx: ExtensionContext): void {
	applyExtensionTheme(fileUrl, ctx);
	applyExtensionTitle(ctx);
}
