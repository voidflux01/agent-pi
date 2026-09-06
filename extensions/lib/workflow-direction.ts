// ABOUTME: Evidence-based next-step advice without changing modes, permissions or contracts.
export interface DirectionInput {
	status: "UNVERIFIED" | "PASS" | "FAIL" | "BLOCKED" | "INCONCLUSIVE";
	failure?: "implementation" | "assumption" | "requirements" | "environment";
	risk?: "low" | "medium" | "high";
	attempt?: number;
	independentTasks?: number;
}
export function workflowDirection(input: DirectionInput) {
	if (input.risk === "high") return { next: "ASK_USER", reason: "Confirm the scope and permission for the high-risk action.", autonomy: "interactive" };
	if (input.status === "INCONCLUSIVE" || input.status === "BLOCKED" || (input.attempt ?? 0) >= 3)
		return { next: "ASK_USER", reason: "Resolve missing evidence, environment or repeated failure before retrying.", autonomy: "interactive" };
	if (input.status === "FAIL") return {
		next: input.failure === "requirements" ? "SPEC" : input.failure === "assumption" ? "PLAN" : input.failure === "environment" ? "ASK_USER" : "BUILD",
		reason: "Repair the identified cause, preserve the accepted criteria, then verify again.", autonomy: "bounded",
	};
	if (input.status === "PASS") return { next: "REPORT", reason: "Confirm the current receipt still matches the workspace; report remaining human gates.", autonomy: "bounded" };
	return { next: "VERIFY", reason: "Collect task-matched evidence; use parallel read-only checks only when independent.", autonomy: "bounded", parallel: (input.independentTasks ?? 0) > 1 };
}
