// ABOUTME: Safe UI harness — try/catch wrappers around extension ctx.ui
// ABOUTME: Extracted from agent-team.ts:270-299 and agent-chain.ts:305-307

interface SafeUiCtx {
	ui?: unknown;
	hasUI?: boolean;
}

/**
 * Run `op` against ctx.ui, swallowing failures (missing UI, stale context,
 * throwing widgets). Returns true when op ran, false otherwise.
 */
export function safeUi(ctx: unknown, op: (ui: any) => void): boolean {
	const c = ctx as SafeUiCtx | null;
	if (!c || c.hasUI === false || !c.ui) return false;
	try {
		op(c.ui);
		return true;
	} catch {
		// Swallow all failures — widget rendering must never break the tool path.
		return false;
	}
}

/** Show a notification via ctx.ui, silently ignored when UI is unavailable. */
export function safeNotify(ctx: unknown, msg: string, type?: string): void {
	safeUi(ctx, (ui) => ui.notify(msg, type));
}

/** Set a status-bar entry via ctx.ui, silently ignored when UI is unavailable. */
export function safeSetStatus(ctx: unknown, key: string, value: string): void {
	safeUi(ctx, (ui) => ui.setStatus(key, value));
}

/** Register a widget via ctx.ui, silently ignored when UI is unavailable. */
export function safeSetWidget(ctx: unknown, key: string, renderer: unknown, options?: unknown): boolean {
	return safeUi(ctx, (ui) => {
		if (options === undefined) {
			ui.setWidget(key, renderer);
		} else {
			ui.setWidget(key, renderer, options);
		}
	});
}

/**
 * Remove a widget by key, tolerant of missing ctx/ui and throwing ui objects.
 * Mirrors the hide pattern in agent-chain.ts:305-307.
 */
export function hideWidget(ctx: unknown, key: string): void {
	const ui = (ctx as SafeUiCtx | undefined)?.ui as
		| { setWidget: (key: string, renderer: unknown) => void }
		| undefined;
	try {
		ui?.setWidget(key, undefined);
	} catch {
		// Ignore — hiding a widget must never throw.
	}
}
