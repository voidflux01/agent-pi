// ABOUTME: Adds an explicit command to persist the current Pi model across sessions.
// ABOUTME: Model switching stays session-scoped until the user deliberately saves it.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { persistModel } from "./lib/persist-model.ts";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("model-save", {
		description: "Persist the current model as the default for future Pi sessions",
		handler: async (_args, ctx) => {
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No model is currently selected.", "warning");
				return;
			}

			try {
				persistModel({ provider: model.provider, modelId: model.id });
				ctx.ui.notify(`Saved default model: ${model.provider}/${model.id}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not save model: ${message}`, "error");
			}
		},
	});
}
