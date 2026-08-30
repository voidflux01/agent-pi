// ABOUTME: Process-spawn rights for child Pi/toolkit/herdr work.
// ABOUTME: Tool and slash-command handlers may open a context; session hooks and timers may not.

import { AsyncLocalStorage } from "node:async_hooks";

export type DispatchOrigin = "agent-team" | "agent-chain" | "pipeline-team" | "subagent-command" | "subagent-tool";

const DISPATCH_AUTHORIZATION = Symbol("explicit-dispatch");

export interface DispatchAuthorization {
	readonly origin: DispatchOrigin;
	readonly token: symbol;
}

interface DispatchContext {
	authorization?: DispatchAuthorization;
	/** A timer or lifecycle boundary cannot be reopened by nested code. */
	blocked: boolean;
}

const dispatchContext = new AsyncLocalStorage<DispatchContext>();
let sessionLifecycleDepth = 0;

function isThenable<T>(value: T): value is T & PromiseLike<unknown> {
	return typeof value === "object" && value !== null && typeof (value as unknown as PromiseLike<unknown>).then === "function";
}

function authorizeDispatch(origin: DispatchOrigin): DispatchAuthorization {
	return { origin, token: DISPATCH_AUTHORIZATION };
}

/**
 * Run a timer callback outside the dispatch context. This is deliberately
 * installed at the timer boundary instead of inspecting async resource class
 * names, which differ between Node and Bun.
 */
let timerBoundariesInstalled = false;
function installTimerBoundaries(): void {
	if (timerBoundariesInstalled) return;
	timerBoundariesInstalled = true;

	const globals = globalThis;
	const wrap = (nativeTimer: Function): Function => (handler: unknown, ...args: unknown[]) => {
		if (typeof handler !== "function") return nativeTimer(handler, ...args);
		const callback = function (this: unknown, ...callbackArgs: unknown[]) {
			const store = dispatchContext.getStore();
			if (!store?.authorization && !store?.blocked) return handler.apply(this, callbackArgs);
			return dispatchContext.run({ blocked: true }, () => handler.apply(this, callbackArgs));
		};
		return nativeTimer(callback, ...args);
	};

	globals.setTimeout = wrap(globals.setTimeout.bind(globals)) as typeof globals.setTimeout;
	globals.setInterval = wrap(globals.setInterval.bind(globals)) as typeof globals.setInterval;
	globals.setImmediate = wrap(globals.setImmediate.bind(globals)) as typeof globals.setImmediate;
}

installTimerBoundaries();

/**
 * Open the only context that may start a child process. Async work created by
 * `operation` keeps the rights until it settles. Timer/immediate callbacks and
 * lifecycle callbacks cannot open or inherit the rights.
 */
function withExplicitDispatch<T>(origin: DispatchOrigin, operation: () => T): T {
	const parent = dispatchContext.getStore();
	const blocked = sessionLifecycleDepth > 0 || !!parent?.blocked;
	return dispatchContext.run(
		blocked ? { blocked: true } : { authorization: authorizeDispatch(origin), blocked: false },
		operation,
	);
}

/**
 * Wrap a Pi tool or slash-command handler with the only dispatch capability.
 * The low-level context opener stays private to this module so call sites must
 * attach authorization at registration time rather than around arbitrary work.
 */
export function explicitDispatchHandler<T extends (...args: any[]) => any>(origin: DispatchOrigin, handler: T): T {
	return ((...args: any[]) => withExplicitDispatch(origin, () => handler(...args))) as T;
}

/**
 * Mark session_start / session_switch / session_shutdown. Dispatch is refused
 * for the duration, even if a caller also opens withExplicitDispatch.
 */
export function withSessionLifecycle<T>(operation: () => T): T {
	sessionLifecycleDepth++;
	try {
		const result = operation();
		if (isThenable(result)) {
			return Promise.resolve(result).finally(() => {
				sessionLifecycleDepth = Math.max(0, sessionLifecycleDepth - 1);
			}) as T;
		}
		sessionLifecycleDepth = Math.max(0, sessionLifecycleDepth - 1);
		return result;
	} catch (error) {
		sessionLifecycleDepth = Math.max(0, sessionLifecycleDepth - 1);
		throw error;
	}
}

export function currentDispatchAuthorization(): DispatchAuthorization | undefined {
	return isExplicitDispatchActive() ? dispatchContext.getStore()?.authorization : undefined;
}

/**
 * Fallback authorization for verifier child-spawns invoked from interactive tool
 * handlers. Identical blocking rules to explicitDispatchHandler: timers and
 * lifecycle boundaries stay blocked; a genuine agent turn may spawn the verifier.
 */
export function dispatchAuthorizationForTurn(): DispatchAuthorization | undefined {
	if (sessionLifecycleDepth > 0) return undefined;
	const store = dispatchContext.getStore();
	if (store?.blocked) return undefined;
	return authorizeDispatch("subagent-tool");
}

export function isExplicitDispatchActive(): boolean {
	if (sessionLifecycleDepth > 0) return false;
	const store = dispatchContext.getStore();
	return !store?.blocked && store?.authorization?.token === DISPATCH_AUTHORIZATION;
}

export function authorizationMatchesActive(authorization: DispatchAuthorization | undefined): boolean {
	return isExplicitDispatchActive() && authorization === dispatchContext.getStore()?.authorization;
}

