// ABOUTME: Admission policy for goal-bearing autonomous completion.
import { AGENT_PI_CONFIG } from "./agent-pi-config.ts";
import { bindAcceptanceContract, type AcceptanceContract } from "./execution-contract.ts";
import { runAutonomousCompletion, type AutonomousCompletionOptions, type AutonomousCompletionResult } from "./autonomous-completion.ts";

export function isAutonomousCompletionEnabled(): boolean {
	return process.env.AGENT_PI_AUTOVERIFY !== "0" && AGENT_PI_CONFIG.autoverify !== false;
}

/** Always admit a task: structured contract when present, otherwise derive a verifiable Objective from the natural-language task text itself. */
export function bindTaskContract(taskText: string, _cwd: string): { contract?: AcceptanceContract } {
	const text = taskText.trim();
	if (!text) return {};
	try {
		const parsed = bindAcceptanceContract(text, "task");
		// Only trust parsed sections when the prompt actually declares them;
		// otherwise bindAcceptanceContract falls back to the first line as title.
		const hasStructuredContract = /^#{2,6}\s+(?:Objective|Contract)\s*$/im.test(text);
		const objective = hasStructuredContract && parsed.objective.trim() && parsed.objective !== "untitled"
			? parsed.objective
			// Natural-language prompt: use the full task text as the verifier's Objective.
			: text.slice(0, 4000);
		return { contract: { ...parsed, objective } };
	} catch {
		return {};
	}
}

export async function autonomousFinalize(input: Omit<AutonomousCompletionOptions, "contract"> & { taskText: string }): Promise<AutonomousCompletionResult | undefined> {
	if (process.env.PI_AGENT_NAME?.toLowerCase() === "verifier") return undefined;
	if (!isAutonomousCompletionEnabled()) return undefined;
	const bound = bindTaskContract(input.taskText, input.cwd);
	if (!bound.contract) return { allowed: false, status: "BLOCKED", reason: "no non-empty task objective", attempts: 0 };
	return runAutonomousCompletion({ ...input, contract: bound.contract });
}
