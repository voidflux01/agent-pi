// ABOUTME: Cycles operational modes (NORMAL/PLAN/SPEC/PIPELINE/TEAM/CHAIN) via Shift+Tab.
// ABOUTME: Gates which extension's before_agent_start fires and injects PLAN/SPEC prompts.

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { outputLine } from "./lib/output-box.ts";
import { applyExtensionDefaults } from "./lib/themeMap.ts";
import { installPinnedToolSurface } from "./lib/pinned-tools.ts";
import { MODES, nextMode, modeLabel, modeBgAnsi, modeTextAnsi, type Mode } from "./lib/mode-cycler-logic.ts";
import { SPEC_PROMPT, buildNormalPrompt, buildPlanPrompt } from "./lib/mode-prompts.ts";
import { rewritePayloadSystemPrompt } from "./lib/rewrite-system-prompt.ts";
import { coordinationState, setCoordinationMode, commanderAvailable as isCommanderAvailable } from "./lib/coordination-state.ts";
import { approvalStateForMode, decideApprovalGate, resetApprovalForMode, resetApprovals } from "./lib/approval-gate.ts";
import { writeFileSync } from "fs";
import { showBanner, isBannerVisible } from "./agent-banner.ts";

const MODE_FILE = "/tmp/pi-current-mode.txt";

/** System prompt to apply on the next provider request after set_mode in this run. */
let midRunSystemPrompt: string | null = null;

export default function (pi: ExtensionAPI) {
	// The extension owns the session mode; initialize the shared bus once per registration.
	midRunSystemPrompt = null;
	resetApprovals();
	setCoordinationMode("NORMAL");
	installPinnedToolSurface(pi);


	function updateWidgets(mode: Mode, ctx: ExtensionContext) {
		if (!ctx.hasUI) return;

		if (mode === "NORMAL") {
			ctx.ui.setWidget("mode-block", undefined);
			// Re-set agent-banner after clearing mode-block to ensure correct rendering order
			// Only re-set if banner was previously visible (not hidden by user input)
			if (isBannerVisible()) {
				showBanner(ctx);
			}
			return;
		}

		// Mode block — full-width colored banner with mode name
		// Uses theme accent color (same as model name in footer)
		ctx.ui.setWidget(
			"mode-block",
			(_tui, _theme) => ({
				invalidate() {},
				render(width: number): string[] {
					const bg = modeBgAnsi(mode);
					const text = modeTextAnsi(mode);
					const reset = "\x1b[0m";
					const label = ` ${mode} `;
					const pad = " ".repeat(Math.max(0, width - label.length));
					return [bg + text + label + pad + reset];
				},
			}),
			{ placement: "aboveEditor" },
		);

		// Re-set agent-banner after setting mode-block to ensure it renders above the bar
		// This maintains the visual hierarchy: agent-banner (logo) → mode-block (bar) → editor
		// Only re-set if banner was previously visible (not hidden by user input)
		if (isBannerVisible()) {
			showBanner(ctx);
		}
	}

	// Expose refresh function so other extensions (e.g. agent-team) can re-pin
	// the mode-block as the last aboveEditor widget (closest to the editor input).
	function refreshModeBlock(ctx: ExtensionContext) {
		updateWidgets(coordinationState().mode, ctx);
	}

	function systemPromptForMode(mode: Mode): string | undefined {
		if (mode === "NORMAL") {
			return buildNormalPrompt({
				commanderAvailable: isCommanderAvailable(),
				activeChain: coordinationState().activeChain,
				activePipeline: coordinationState().activePipeline,
			});
		}
		if (mode === "PLAN") return buildPlanPrompt(isCommanderAvailable());
		if (mode === "SPEC") return SPEC_PROMPT;
		return undefined;
	}

	function setMode(mode: Mode, ctx: ExtensionContext) {
		const previous = coordinationState().mode;
		setCoordinationMode(mode, ctx);
		if (mode === "PIPELINE") {
			// Pipeline selection is owned by pipeline-team. Ask it to reconcile
			// its config here because its session-start listener can be registered
			// after this mode change in a freshly booted Pi.
			try { (globalThis as any).__piActivatePipeline?.(ctx); } catch {}
		}
		if (previous !== mode) resetApprovalForMode(mode);
		(globalThis as any).__piSetMode = (next: Mode, nextCtx?: ExtensionContext) => {
			setMode(next, nextCtx || ctx);
		};

		// Write to temp file for statusline
		try { writeFileSync(MODE_FILE, mode, "utf-8"); } catch {}

		if (ctx.hasUI) {
			ctx.ui.setStatus("mode", modeLabel(mode));
		}

		// Publish refresh callback so other aboveEditor widgets can re-pin the mode bar
		(globalThis as any).__piRefreshModeBlock = () => refreshModeBlock(ctx);

		updateWidgets(mode, ctx);
	}

	// ── /mode command ─────────────────────────────

	pi.registerCommand("mode", {
		description: "Set mode: /mode or /mode <MODE>",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;

			const arg = args.trim().toUpperCase();
			if (arg && MODES.includes(arg as Mode)) {
				setMode(arg as Mode, ctx);
				return;
			}

			if (arg) {
				ctx.ui.notify(`Unknown mode: ${arg}. Valid: ${MODES.join(", ")}`, "error");
				return;
			}

			// Picker
			const items = MODES.map(m => {
				const active = m === coordinationState().mode ? " (active)" : "";
				return `${m}${active}`;
			});
			const selected = await ctx.ui.select("Select Mode", items);
			if (!selected) return;

			const name = selected.split(/\s/)[0] as Mode;
			setMode(name, ctx);
		},
	});

	// ── set_mode tool (autonomous mode switching) ──

	pi.registerTool({
		name: "set_mode",
		label: "Set Mode",
		description: "Switch the operational mode. Call this from NORMAL mode to activate PLAN, SPEC, TEAM, CHAIN, or PIPELINE based on task classification.",
		parameters: Type.Object({
			mode: Type.String({ description: "Target mode: NORMAL, PLAN, SPEC, PIPELINE, TEAM, or CHAIN" }),
			reason: Type.Optional(Type.String({ description: "Why this mode was chosen" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { mode: target, reason } = params as { mode: string; reason?: string };
			const upper = target.toUpperCase();

			if (!MODES.includes(upper as Mode)) {
				return {
					content: [{ type: "text", text: `Unknown mode: ${target}. Valid: ${MODES.join(", ")}` }],
					details: { error: true },
				};
			}

			const changed = upper !== coordinationState().mode;
			setMode(upper as Mode, ctx);
			let msg = reason
				? `Mode set to ${upper}. Reason: ${reason}`
				: `Mode set to ${upper}.`;

			// before_agent_start already ran with the old mode prompt. Swap the
			// system prompt on the next provider request in this same run so we
			// do not abort (that printed "This operation was aborted") or inject
			// a fake "Continue the task in PLAN mode." user turn.
			if (changed) {
				midRunSystemPrompt = systemPromptForMode(upper as Mode) ?? null;
				if (upper === "PLAN") {
					msg += " Scout if you cannot name the files to change, then write .context/todo.md and call show_plan. Implementation is blocked until the plan is approved.";
				}
				if (ctx.hasUI) {
					try { ctx.ui.notify(`Switched to ${upper}.`, "info"); } catch {}
				}
			}

			return {
				content: [{ type: "text", text: msg }],
				details: { mode: upper, reason },
			};
		},

		renderCall(args, theme) {
			const target = (args as any).mode || "?";
			const reason = (args as any).reason || "";
			const preview = reason.length > 50 ? reason.slice(0, 47) + "..." : reason;
			const text =
				theme.fg("toolTitle", theme.bold("set_mode ")) +
				theme.fg("accent", target.toUpperCase()) +
				(preview ? theme.fg("dim", " — ") + theme.fg("muted", preview) : "");
			return new Text(outputLine(theme, "accent", text), 0, 0);
		},

		renderResult(result, _options, theme) {
			const text = result.content[0];
			const msg = text?.type === "text" ? text.text : "";
			return new Text(outputLine(theme, "success", msg), 0, 0);
		},
	});

	// ── System prompt injection per mode ─────────

	pi.on("tool_call", async (event, ctx) => {
		if (process.env.PI_SUBAGENT === "1") return { block: false };
		const mode = coordinationState().mode;
		return decideApprovalGate({
			mode,
			approved: approvalStateForMode(mode),
			toolName: event.toolName,
			args: event.arguments || event.params || event.input,
			cwd: ctx?.cwd,
		});
	});

	pi.on("before_agent_start", async (_event, _ctx) => {
		midRunSystemPrompt = null;
		const systemPrompt = systemPromptForMode(coordinationState().mode);
		return systemPrompt ? { systemPrompt } : {};
	});

	pi.on("before_provider_request", (event) => {
		if (!midRunSystemPrompt) return;
		const { payload, applied } = rewritePayloadSystemPrompt(event.payload, midRunSystemPrompt);
		if (applied) return payload;
	});

	// ── Session init ──────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		midRunSystemPrompt = null;
		resetApprovals();
		(globalThis as any).__piSetMode = (next: Mode, nextCtx?: ExtensionContext) => {
			setMode(next, nextCtx || ctx);
		};
		setCoordinationMode("NORMAL", ctx);
		(globalThis as any).__piRefreshModeBlock = () => refreshModeBlock(ctx);
		try { writeFileSync(MODE_FILE, "NORMAL", "utf-8"); } catch {}
		if (ctx.hasUI) {
			ctx.ui.setStatus("mode", "");
		}
		updateWidgets("NORMAL", ctx);
	});

	// ── Session switch (/new) ──────────────────────

	pi.on("session_switch", async (_event, ctx) => {
		// Re-apply current mode widgets after banner is shown to ensure correct rendering order
		// The banner is shown in agent-banner.ts's session_switch handler, so we need to
		// re-set widgets here to ensure mode-block (if any) renders before banner is re-set
		// Use process.nextTick to ensure banner's session_switch handler runs first
		process.nextTick(() => {
			updateWidgets(coordinationState().mode, ctx);
		});
	});
}
