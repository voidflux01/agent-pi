// ABOUTME: Deterministic resource-aware waves for parallel orchestration.
// ABOUTME: Undeclared resources preserve existing concurrency; overlapping
// ABOUTME: declared keys are never placed in the same wave.

export interface ResourceScheduledJob {
	resources?: string[];
}

const MAX_RESOURCE_KEYS = 16;
const MAX_RESOURCE_LENGTH = 160;

export function normalizeResourceKeys(resources: unknown): string[] {
	if (!Array.isArray(resources)) return [];
	return [...new Set(resources
		.filter((resource): resource is string => typeof resource === "string")
		.map((resource) => resource.trim().toLowerCase().slice(0, MAX_RESOURCE_LENGTH))
		.filter(Boolean))].slice(0, MAX_RESOURCE_KEYS);
}

/** Build deterministic, bounded waves. A resource-free job can share any wave. */
export function scheduleResourceWaves<T extends ResourceScheduledJob>(jobs: T[], maxParallel: number): number[][] {
	const limit = Math.max(1, Math.floor(maxParallel) || 1);
	const remaining = jobs.map((_, index) => index);
	const waves: number[][] = [];
	while (remaining.length > 0) {
		const wave: number[] = [];
		const resources = new Set<string>();
		for (let cursor = 0; cursor < remaining.length && wave.length < limit;) {
			const index = remaining[cursor];
			const keys = normalizeResourceKeys(jobs[index]?.resources);
			if (keys.some((key) => resources.has(key))) {
				cursor += 1;
				continue;
			}
			wave.push(index);
			keys.forEach((key) => resources.add(key));
			remaining.splice(cursor, 1);
		}
		// A bounded key list cannot deadlock, but retain a progress guard if the
		// implementation changes or receives an exotic array-like input.
		if (wave.length === 0) wave.push(remaining.shift()!);
		waves.push(wave);
	}
	return waves;
}
