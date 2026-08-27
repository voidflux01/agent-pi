// ABOUTME: grill-core — shared design-interview state for the plan viewer's
// ABOUTME: built-in /grill-me integration. State lives in .pi/grill-me/
// ABOUTME: state.json inside the project; results render to a Markdown file
// ABOUTME: so the interview survives sessions and can be revisited or saved.
// Ported from @firstpick/pi-extension-grill-me (MIT) so show_plan can arm
// and consume interviews without depending on an external package.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface GrillTurn {
	question: string;
	recommendedAnswer: string;
	userAnswer?: string;
	decisionStatus: "resolved" | "open" | "needs-codebase-check";
	notes?: string;
}

export interface GrillState {
	createdAt: string;
	updatedAt: string;
	projectDir: string;
	plan: string;
	sourcePlanFile?: string;
	viewerArmedAt?: string;
	turns: GrillTurn[];
}

export interface GrillResultsExtra {
	summary?: string;
	agreedDecisions?: string[];
	openRisks?: string[];
	nextDecisionNeeded?: string;
}

export function grillStateDir(cwd: string): string {
	return join(cwd, ".pi", "grill-me");
}

export function grillStatePath(cwd: string): string {
	return join(grillStateDir(cwd), "state.json");
}

export function readGrillState(cwd: string): GrillState | undefined {
	try {
		return JSON.parse(readFileSync(grillStatePath(cwd), "utf8")) as GrillState;
	} catch {
		return undefined;
	}
}

export function writeGrillState(cwd: string, state: GrillState): void {
	mkdirSync(grillStateDir(cwd), { recursive: true });
	writeFileSync(grillStatePath(cwd), JSON.stringify(state, null, 2) + "\n", "utf8");
}

/** Initialize (or re-arm) interview state from the plan currently shown. */
export function armGrillSession(cwd: string, plan: string, sourcePlanFile?: string): GrillState {
	const existing = readGrillState(cwd);
	const state: GrillState = existing ?? {
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		projectDir: cwd,
		plan,
		turns: [],
	};
	state.plan = plan;
	state.sourcePlanFile = sourcePlanFile;
	state.viewerArmedAt = new Date().toISOString();
	state.updatedAt = new Date().toISOString();
	writeGrillState(cwd, state);
	return state;
}

export function recordGrillTurn(
	cwd: string,
	turn: GrillTurn,
): { ok: true; count: number } | { ok: false; error: string } {
	if (turn.decisionStatus === "resolved" && !turn.userAnswer?.trim()) {
		return { ok: false, error: "userAnswer is required for resolved turns. Retry with the user's explicit choice or the answer discovered from the codebase." };
	}
	const state = readGrillState(cwd) ?? {
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		projectDir: cwd,
		plan: "(state was created by grill_record_turn; no plan recorded)",
		turns: [],
	};
	state.turns.push({ ...turn, userAnswer: turn.userAnswer?.trim() || undefined });
	state.updatedAt = new Date().toISOString();
	writeGrillState(cwd, state);
	return { ok: true, count: state.turns.length };
}

function safeOutputPath(cwd: string, input?: string): string {
	const requested = input?.trim() || "GRILL-ME.md";
	const absolute = resolve(cwd, requested);
	const root = resolve(cwd);
	if (absolute !== root && !absolute.startsWith(root + "/")) {
		throw new Error(`Refusing to write outside project directory: ${requested}`);
	}
	return absolute;
}

export function renderGrillMarkdown(state: GrillState, extra: GrillResultsExtra): string {
	const lines: string[] = [];
	lines.push("# Grill Me Results", "");
	lines.push(`Generated: ${new Date().toISOString()}`, "");
	lines.push("## Plan", "", state.plan.trim() || "_(none recorded)_", "");
	if (extra.summary?.trim()) lines.push("## Shared Understanding", "", extra.summary.trim(), "");
	lines.push("## Questions and Answers", "");
	if (state.turns.length === 0) {
		lines.push("_(No turns recorded.)", "");
	} else {
		state.turns.forEach((turn, index) => {
			lines.push(`### ${index + 1}. ${turn.question}`, "");
			lines.push(`**Recommended answer:** ${turn.recommendedAnswer || "_(none)_"}`, "");
			lines.push(`**User answer:** ${turn.userAnswer || "_(not recorded)_"}`, "");
			lines.push(`**Status:** ${turn.decisionStatus}`, "");
			if (turn.notes?.trim()) lines.push(`**Notes:** ${turn.notes.trim()}`, "");
		});
	}
	if (extra.agreedDecisions?.length) lines.push("## Agreed Decisions", "", ...extra.agreedDecisions.map((d) => `- ${d}`), "");
	if (extra.openRisks?.length) lines.push("## Open Risks", "", ...extra.openRisks.map((r2) => `- ${r2}`), "");
	if (extra.nextDecisionNeeded?.trim()) lines.push("## Next Decision Needed", "", extra.nextDecisionNeeded.trim(), "");
	return lines.join("\n") + "\n";
}

/** Save interview results to Markdown. Returns the output path. */
export function saveGrillResults(cwd: string, extra: GrillResultsExtra, path?: string): { path: string; turns: number } | { error: string } {
	const state = readGrillState(cwd);
	if (!state) return { error: "No active grill-me session found. Show a plan first." };
	let out: string;
	try {
		out = safeOutputPath(cwd, path);
	} catch (e: any) {
		return { error: e.message };
	}
	writeFileSync(out, renderGrillMarkdown(state, extra), "utf8");
	return { path: out, turns: state.turns.length };
}
