// ABOUTME: Opt-in workspace retrospectives: deterministic facts first, insights second.
// ABOUTME: Insights carry kind + lifecycle status; rule drafts never auto-write to rule files.
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveArtifact, readBounded, safeWorkspacePath, redactEvidence } from "./workflow-artifacts.ts";

export interface RunSummary {
	runId: string; actor: string; mode?: string; status: string; durationMs: number;
	stepsUsed: number; usage: { totalTokens: number; costUsd: number }; evidenceRefs: string[];
	taskText?: string;
}
export type InsightKind = "fact" | "hypothesis" | "rule_draft";
export type InsightStatus = "active" | "adopted" | "rejected" | "stale";
export interface RetrospectiveInsight {
	id: string; kind: InsightKind; text: string;
	evidence_refs: string[]; status: InsightStatus;
}
const MAX_INSIGHTS = 40;
const INSIGHT_TEXT_LIMIT = 2000;

function sanitizeInsight(raw: RetrospectiveInsight): RetrospectiveInsight | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	if (!/^[a-zA-Z0-9-]{1,80}$/.test(String(raw.id))) return undefined;
	if (!["fact", "hypothesis", "rule_draft"].includes(raw.kind)) return undefined;
	if (typeof raw.text !== "string" || !raw.text.trim()) return undefined;
	if (!["active", "adopted", "rejected", "stale"].includes(raw.status)) return undefined;
	return {
		id: raw.id, kind: raw.kind,
		text: redactEvidence(raw.text).slice(0, INSIGHT_TEXT_LIMIT),
		evidence_refs: (Array.isArray(raw.evidence_refs) ? raw.evidence_refs : []).filter(r => typeof r === "string").slice(0, 10),
		status: raw.status,
	};
}

/**
 * Facts-only record when no insights are supplied: without model review the
 * store keeps deterministic run metadata and never fabricates lessons or causes.
 */
export function saveRetrospective(cwd: string, summary: RunSummary, options?: { insights?: RetrospectiveInsight[]; generator?: string }): string | undefined {
	const insights = (options?.insights ?? []).map(sanitizeInsight).filter((i): i is RetrospectiveInsight => !!i).slice(0, MAX_INSIGHTS);
	const record = {
		schema_version: 1, created_at: new Date().toISOString(), scope: "workspace", run_id: summary.runId,
		actor: summary.actor, mode: summary.mode, status: summary.status,
		task_text: summary.taskText ? redactEvidence(summary.taskText).slice(0, 2000) : undefined,
		metrics: { duration_ms: summary.durationMs, steps: summary.stepsUsed, ...summary.usage },
		evidence_refs: summary.evidenceRefs.slice(0, 20),
		// Deterministic facts are always present; insights exist only when a
		// model-backed review actually produced them.
		facts: {
			terminal_status: summary.status,
			steps_used: summary.stepsUsed,
			tokens: summary.usage.totalTokens,
			cost_usd: summary.usage.costUsd,
			evidence_refs: summary.evidenceRefs.slice(0, 20),
		},
		experience: {
			available: insights.length > 0,
			generator: insights.length > 0 ? redactEvidence(options?.generator ?? "unspecified") : null,
		},
		insights,
		privacy: { redacted: true, scope: "workspace", source: "allowlisted-run-metadata" },
	};
	try { return saveArtifact(cwd, "retrospectives", record, summary.runId); }
	catch (error: any) { if (error.code === "EEXIST") return undefined; throw error; }
}

function retrospectivePath(cwd: string, runId: string): string {
	if (!/^[a-zA-Z0-9-]{1,120}$/.test(runId)) throw new Error("Invalid run id");
	return safeWorkspacePath(cwd, join(".pi/workflow/retrospectives", `${runId}.json`));
}

function readRetrospective(cwd: string, runId: string): any | undefined {
	const relative = join(".pi/workflow/retrospectives", `${runId}.json`);
	if (!existsSync(retrospectivePath(cwd, runId))) return undefined;
	try {
		const record = JSON.parse(readBounded(cwd, relative));
		if (record?.schema_version !== 1 || record.scope !== "workspace") return undefined;
		return record;
	} catch { return undefined; }
}

function writeRetrospective(cwd: string, runId: string, record: any): string {
	const path = retrospectivePath(cwd, runId);
	writeFileSync(path, redactEvidence(JSON.stringify(record, null, 2)) + "\n", { mode: 0o600 });
	return path;
}

/**
 * Explicit insight augmentation for callers with model access. Never called
 * automatically; insights must cite evidence and keep kind/status honest.
 */
export function augmentRetrospective(cwd: string, runId: string, insights: RetrospectiveInsight[], generator: string): string | undefined {
	const record = readRetrospective(cwd, runId);
	if (!record) return undefined;
	const clean = insights.map(sanitizeInsight).filter((i): i is RetrospectiveInsight => !!i).slice(0, MAX_INSIGHTS);
	const existing = new Set((record.insights ?? []).map((i: RetrospectiveInsight) => i.id));
	const added = clean.filter(i => !existing.has(i.id));
	if (!added.length) return undefined;
	record.insights = [...(record.insights ?? []), ...added].slice(0, MAX_INSIGHTS);
	record.experience = { available: true, generator: redactEvidence(generator) };
	return writeRetrospective(cwd, runId, record);
}

/** Explicit lifecycle transitions; only user action may adopt, reject or expire an insight. */
export function markInsight(cwd: string, runId: string, insightId: string, status: Exclude<InsightStatus, "active">): boolean {
	const record = readRetrospective(cwd, runId);
	const insight = (record?.insights ?? []).find((i: RetrospectiveInsight) => i.id === insightId);
	if (!insight) return false;
	insight.status = status;
	writeRetrospective(cwd, runId, record);
	return true;
}

/** Bounded listing for `/workflow retrospective list`. */
export function listRetrospectives(cwd: string, limit = 20): Array<{ run_id: string; actor: string; status: string; created_at: string; insights: number }> {
	const dir = safeWorkspacePath(cwd, ".pi/workflow/retrospectives");
	const relative = ".pi/workflow/retrospectives";
	let names: string[] = [];
	try { names = readdirSync(dir).filter(n => /^[a-zA-Z0-9-]+\.json$/.test(n)); } catch (error: any) { if (error?.code === "ENOENT") return []; throw error; }
	const listed: ReturnType<typeof listRetrospectives> = [];
	for (const name of names.slice(-500)) {
		try {
			const record = JSON.parse(readBounded(cwd, join(relative, name)));
			if (record?.schema_version !== 1 || record.scope !== "workspace") continue;
			listed.push({ run_id: record.run_id, actor: record.actor, status: record.status, created_at: record.created_at, insights: Array.isArray(record.insights) ? record.insights.length : 0 });
		} catch { /* Corrupt entries are skipped. */ }
	}
	return listed.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, Math.max(1, Math.min(50, limit)));
}

/** User-explicit deletion via `/workflow retrospective clear`; nothing auto-deletes. */
export function clearRetrospectives(cwd: string, runId?: string): number {
	const path = safeWorkspacePath(cwd, ".pi/workflow/retrospectives");
	if (!existsSync(path)) return 0;
	let names = readdirSync(path).filter(n => /^[a-zA-Z0-9-]+\.json$/.test(n));
	if (runId) names = names.filter(n => n === `${runId}.json`);
	let removed = 0;
	for (const name of names) { try { rmSync(join(path, name)); removed++; } catch { /* Keep other entries. */ } }
	return removed;
}

export function searchRetrospectives(cwd: string, query: string, limit = 10) {
	const relative = ".pi/workflow/retrospectives";
	let names: string[];
	try { names = readdirSync(safeWorkspacePath(cwd, relative)).filter(n => /^[a-zA-Z0-9-]+\.json$/.test(n)).slice(-500); }
	catch (error: any) { if (error.code === "ENOENT") return []; throw error; }
	const matches: any[] = [];
	for (const name of names) {
		try {
			const record = JSON.parse(readBounded(cwd, join(relative, name)));
			if (record.schema_version !== 1 || record.scope !== "workspace") continue;
			// Searchable experience: only active or adopted insights are injected;
			// rejected and stale lessons never re-enter context.
			const injectable = (record.insights ?? []).filter((i: RetrospectiveInsight) => i.status === "active" || i.status === "adopted");
			const haystack = JSON.stringify({ run_id: record.run_id, actor: record.actor, mode: record.mode, facts: record.facts, task_text: record.task_text, status: record.status, insights: injectable }).toLowerCase();
			if (!haystack.includes(query.toLowerCase())) continue;
			matches.push({
				run_id: record.run_id, status: record.status, created_at: record.created_at,
				task_text: record.task_text, facts: record.facts,
				insights: injectable.slice(0, 10),
				experience: record.experience ?? { available: false, generator: null },
				source: `${relative}/${name}`, trust: "untrusted historical evidence",
			});
		} catch { /* Corrupt or unsupported entries never become context. */ }
	}
	return matches.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, Math.max(1, Math.min(20, limit)));
}
