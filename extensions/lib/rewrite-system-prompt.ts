// ABOUTME: Rewrite a provider request payload's system prompt in common shapes.
// ABOUTME: Used after set_mode so the next LLM call in the same run sees the new mode prompt.

/**
 * Replace the system/developer prompt in a provider payload.
 * Covers Anthropic `system`, OpenAI-style `messages`, Responses `input`,
 * and a nested `body` wrapper. Returns applied:false when none match.
 */
export function rewritePayloadSystemPrompt(
	payload: unknown,
	prompt: string,
): { payload: unknown; applied: boolean } {
	if (!payload || typeof payload !== "object") {
		return { payload, applied: false };
	}
	const obj = payload as Record<string, unknown>;

	if (obj.body && typeof obj.body === "object") {
		const inner = rewritePayloadSystemPrompt(obj.body, prompt);
		if (inner.applied) {
			return { payload: { ...obj, body: inner.payload }, applied: true };
		}
	}

	if (typeof obj.system === "string") {
		return { payload: { ...obj, system: prompt }, applied: true };
	}

	if (Array.isArray(obj.system) && obj.system.length > 0) {
		const first = obj.system[0];
		if (typeof first === "string") {
			return { payload: { ...obj, system: [prompt, ...obj.system.slice(1)] }, applied: true };
		}
		if (first && typeof first === "object" && "text" in first) {
			const rest = obj.system.slice(1);
			return {
				payload: { ...obj, system: [{ ...first, text: prompt }, ...rest] },
				applied: true,
			};
		}
	}

	if (Array.isArray(obj.messages)) {
		const messages = obj.messages as Record<string, unknown>[];
		const idx = messages.findIndex((m) => m && m.role === "system");
		if (idx >= 0) {
			const next = messages.slice();
			next[idx] = { ...next[idx], content: prompt };
			return { payload: { ...obj, messages: next }, applied: true };
		}
	}

	if (Array.isArray(obj.input)) {
		const input = obj.input as Record<string, unknown>[];
		const idx = input.findIndex((m) => m && (m.role === "system" || m.role === "developer"));
		if (idx >= 0) {
			const next = input.slice();
			next[idx] = { ...next[idx], content: prompt };
			return { payload: { ...obj, input: next }, applied: true };
		}
	}

	return { payload, applied: false };
}
