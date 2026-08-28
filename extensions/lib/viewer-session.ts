// ABOUTME: Shared helpers for tracking and closing the currently active local browser viewer from the CLI.
// ABOUTME: Lets multiple viewer extensions expose a consistent CLI close path without duplicating server bookkeeping.

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Server } from "node:http";

export type ActiveViewerKind = "file" | "plan" | "questions" | "spec" | "report" | "sounds" | "qa" | "setup" | "board" | "chat";

export interface ActiveViewerSession {
	kind: ActiveViewerKind;
	title: string;
	url: string;
	/** Tokenized launch URL when the public `url` is not enough to load the page. */
	launchUrl?: string;
	server: Server;
	onClose: () => void;
}

let activeViewer: ActiveViewerSession | null = null;

export function clearActiveViewer(session?: ActiveViewerSession | null): void {
	if (!session) {
		activeViewer = null;
		return;
	}
	if (activeViewer === session) activeViewer = null;
}

export function registerActiveViewer(session: ActiveViewerSession): void {
	if (activeViewer && activeViewer !== session) {
		try { activeViewer.server.close(); } catch {}
		try { activeViewer.onClose(); } catch {}
	}
	activeViewer = session;
}

export function getActiveViewer(): ActiveViewerSession | null {
	return activeViewer;
}

export function closeActiveViewer(): { closed: boolean; kind?: ActiveViewerKind; title?: string } {
	const session = activeViewer;
	if (!session) return { closed: false };
	activeViewer = null;
	try { session.server.close(); } catch {}
	try { session.onClose(); } catch {}
	return { closed: true, kind: session.kind, title: session.title };
}

export function notifyViewerOpen(ctx: ExtensionContext, session: ActiveViewerSession): void {
	const where = session.launchUrl || session.url;
	const msg = `${session.title} opened at ${where}`;
	if (!ctx.hasUI) return;
	ctx.ui.notify(msg, "info");
	try { ctx.ui.setStatus(msg, "viewer"); } catch {}
}

/** Loopback origin plus the one-time capability URL that actually loads the page. */
export function localViewerLaunch(port: number, token: string): { url: string; launchUrl: string } {
	const url = `http://127.0.0.1:${port}`;
	return { url, launchUrl: `${url}/?token=${encodeURIComponent(token)}` };
}
