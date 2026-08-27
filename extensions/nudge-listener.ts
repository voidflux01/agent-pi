// ABOUTME: nudge-listener — child-side auto-delivery of steer mails.
// ABOUTME: Polls THIS agent's mailbox inbox for kind=="steer" records and
// ABOUTME: injects each body into the running session via sendUserMessage
// ABOUTME: ({ deliverAs: "steer" }) — pi's native mid-turn channel — then
// ABOUTME: acknowledges in place and consumes the file. The agent name comes
// ABOUTME: from PI_AGENT_NAME (same contract ask_parent uses). External CLIs
// ABOUTME: don't load this; they follow PREAMBLE v2 teaching instead.
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { listSteer, ackSteer, consumeSteer, mailboxRoot } from "./lib/fleet-mailbox.ts";

/** One poll pass: deliver every pending steer mail for PI_AGENT_NAME. */
export function pollSteersOnce(
	pi: { sendUserMessage: (content: string, opts?: any) => Promise<void>; sendMessage?: (m: any, o?: any) => Promise<void> },
	agentNameArg?: string,
): number {
	const agentName = (agentNameArg || process.env.PI_AGENT_NAME || "").toLowerCase();
	if (!agentName) return 0;
	let delivered = 0;
	try {
		const root = mailboxRoot(process.cwd());
		for (const { path, rec } of listSteer(root, agentName)) {
			try { ackSteer(root, path); } catch {}
			const body = rec.body ?? "";
			void pi.sendUserMessage(`[STEER from captain] ${body}`, { deliverAs: "steer" }).catch(() => {
				// steer unavailable — fall back to next-turn message
				return pi.sendMessage?.({ customType: "nudge", content: `[STEER from captain] ${body}`, display: true }, { deliverAs: "nextTurn", triggerTurn: false });
			});
			delivered++;
			setTimeout(() => { try { consumeSteer(root, path); } catch {} }, 1000);
		}
	} catch {}
	return delivered;
}

export default function (pi: ExtensionAPI) {
	const agentName = (process.env.PI_AGENT_NAME || "").toLowerCase();
	if (!agentName) return;
	setInterval(() => { pollSteersOnce(pi as unknown as Parameters<typeof pollSteersOnce>[0], agentName); }, 1500);
}
