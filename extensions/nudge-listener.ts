// ABOUTME: nudge-listener — child-side auto-delivery of steer mails.
// ABOUTME: Polls THIS agent's mailbox inbox for kind=="steer" records and
// ABOUTME: injects each body into the running session via sendUserMessage
// ABOUTME: ({ deliverAs: "steer" }) — pi's native mid-turn channel — then
// ABOUTME: acknowledges in place and consumes the file. The agent name comes
// ABOUTME: from PI_AGENT_NAME (same contract ask_parent uses). External CLIs
// ABOUTME: don't load this; they follow PREAMBLE v2 teaching instead.
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { listSteer, ackSteer, consumeSteer, mailboxRoot } from "./lib/fleet-mailbox.ts";

const inFlight = new Set<string>();

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
			if (inFlight.has(path)) continue;
			inFlight.add(path);
			const body = rec.body ?? "";
			const settle = (ok: boolean) => {
				inFlight.delete(path);
				if (!ok) return; // Keep the mail for a later retry if delivery failed.
				ackSteer(root, path);
				setTimeout(() => { consumeSteer(root, path); }, 1000);
			};
			void pi.sendUserMessage(`[STEER from captain] ${body}`, { deliverAs: "steer" }).then(
				() => settle(true),
				async () => {
					// steer unavailable — fall back to a next-turn message
					if (!pi.sendMessage) { settle(false); return; }
					try {
						await pi.sendMessage({ customType: "nudge", content: `[STEER from captain] ${body}`, display: true }, { deliverAs: "nextTurn", triggerTurn: false });
						settle(true);
					} catch { settle(false); }
				},
			);
			delivered++;
		}
	} catch {}
	return delivered;
}

export default function (pi: ExtensionAPI) {
	const agentName = (process.env.PI_AGENT_NAME || "").toLowerCase();
	if (!agentName) return;
	let timer: ReturnType<typeof setInterval> | undefined;
	const start = () => {
		if (!timer) timer = setInterval(() => { pollSteersOnce(pi as unknown as Parameters<typeof pollSteersOnce>[0], agentName); }, 1500);
	};
	const stop = () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	};
	pi.on("session_start", async () => start());
	pi.on("session_shutdown", async () => stop());
	start();
}
