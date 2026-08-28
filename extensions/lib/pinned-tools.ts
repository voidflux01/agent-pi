// ABOUTME: Keep orchestration tools visible when another extension narrows
// ABOUTME: the first-turn tool surface (Flash route leases).

/** Tools the parent must see on turn 1 or PLAN/scout never starts. */
export const PINNED_ORCHESTRATION_TOOLS = [
	"set_mode",
	"tasks",
	"subagent_create",
	"subagent_create_batch",
	"show_plan",
	"dispatch_agent",
	"ask_user",
] as const;

export function pinOrchestrationTools(active: string[], full: string[]): string[] {
	const have = new Set(active);
	const allowed = new Set(full);
	const next = [...active];
	for (const name of PINNED_ORCHESTRATION_TOOLS) {
		if (allowed.has(name) && !have.has(name)) {
			next.push(name);
			have.add(name);
		}
	}
	return next;
}

export function installPinnedToolSurface(pi: {
	getActiveTools: () => string[];
	setActiveTools: (names: string[]) => void;
	on: (event: string, handler: (...args: any[]) => void) => void;
}): void {
	if (process.env.PI_PIN_ORCHESTRATION_TOOLS === "0") return;
	let snapshot: string[] | null = null;
	let pinActive = false;

	const capture = () => {
		const tools = pi.getActiveTools();
		if (tools.length > (snapshot?.length ?? 0)) snapshot = tools;
	};

	const pin = () => {
		if (!snapshot) capture();
		if (!snapshot) return;
		const current = pi.getActiveTools();
		const next = pinOrchestrationTools(current, snapshot);
		if (next.length === current.length && next.every((n, i) => n === current[i])) return;
		pi.setActiveTools(next);
		pinActive = true;
	};

	const restore = () => {
		if (!pinActive || !snapshot) return;
		pi.setActiveTools(snapshot);
		pinActive = false;
	};

	pi.on("session_start", capture);
	pi.on("context", pin);
	pi.on("tool_call", restore);
	pi.on("agent_settled", restore);
}
