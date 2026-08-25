// ABOUTME: Resolves subagent models without silently changing the parent session's provider.
// ABOUTME: Explicit agent routing wins; otherwise execution inherits the model that launched Pi.

export interface ProviderModelRef {
	provider?: unknown;
	id?: unknown;
}

/** Convert Pi's runtime model reference to its provider/model CLI identifier. */
export function providerModelString(model: ProviderModelRef | null | undefined): string {
	if (typeof model?.provider !== "string" || typeof model.id !== "string") return "";
	if (!model.provider || !model.id) return "";
	return `${model.provider}/${model.id}`;
}

/**
 * Resolve a chain worker model without introducing an implicit provider change.
 * Explicit project/user/frontmatter routing wins, followed by the launching
 * session model and finally the legacy fallback for runtimes with no model.
 */
export function resolveInheritedModel(
	explicitModel: string | null | undefined,
	launchModel: string | null | undefined,
	fallbackModel: string,
): string {
	return explicitModel || launchModel || fallbackModel;
}
