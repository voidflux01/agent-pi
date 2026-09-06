// ABOUTME: Shared structural theme type for pure TUI render modules
// ABOUTME: Bridges pi Theme, RenderTheme, and OutputBoxTheme via one cast

/**
 * Minimal structural theme accepted by every lib/tui render function.
 * Structurally compatible with pi `Theme`, `RenderTheme`, and `OutputBoxTheme`.
 */
export type UiTheme = {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
	bg?: (color: string, text: string) => string;
};

/** Cast an unknown theme object to UiTheme exactly once, at the lib boundary. */
export function asUiTheme(theme: unknown): UiTheme {
	return theme as UiTheme;
}
