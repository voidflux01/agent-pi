// ABOUTME: Proposal-bound human approval gate: resumable pending state, fail-closed checks.
// ABOUTME: Approvals are bound to an exact proposal fingerprint; any proposal change invalidates them.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digest, redactEvidence, safeWorkspacePath } from "./workflow-artifacts.ts";

const APPROVALS_DIR = ".pi/workflow/approvals";
export const APPROVAL_MAX_AGE_MS_DEFAULT = 24 * 60 * 60 * 1000;
const MAX_LISTED_APPROVALS = 50;

export interface ApprovalProposal {
	/** Short human-readable proposal title. */
	title: string;
	/** Concrete action that will execute after approval (e.g. "apply log-triage fix"). */
	action: string;
	/** Exact scope that was shown to and approved by the user. */
	scope: string;
	/** Workspace-relative files the action intends to touch. */
	artifacts?: string[];
	runId?: string;
}

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface ApprovalRecord {
	schema_version: 1;
	proposal_hash: string;
	title: string;
	action: string;
	scope: string;
	artifacts: string[];
	status: ApprovalStatus;
	created_at: string;
	decided_at?: string;
	expires_at?: string;
	reason?: string;
	run_id?: string;
	privacy: { redacted: true; scope: "workspace" };
}

export interface ApprovalDecision {
	approved: boolean;
	/** APPROVED = matching fresh approval; everything else fails closed. */
	status: "APPROVED" | "PENDING" | "REJECTED" | "MISSING" | "STALE";
	proposalHash: string;
	path?: string;
	reason: string;
}

/** Stable canonical JSON so fingerprinting ignores key order. */
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function proposalFingerprint(proposal: ApprovalProposal): string {
	return digest(canonicalJson({ title: proposal.title, action: proposal.action, scope: proposal.scope, artifacts: proposal.artifacts ?? [] }));
}

function recordPath(cwd: string, proposalHash: string): string {
	return join(cwd, APPROVALS_DIR, `proposal-${proposalHash}.json`);
}

function readRecord(cwd: string, proposalHash: string): ApprovalRecord | undefined {
	const path = recordPath(cwd, proposalHash);
	if (!existsSync(path)) return undefined;
	try {
		const record = JSON.parse(redactEvidence(readFileSync(path, "utf8"))) as ApprovalRecord;
		if (record?.schema_version !== 1 || typeof record.proposal_hash !== "string" || typeof record.status !== "string") return undefined;
		// A record keyed under a different hash is corrupt or stale storage; treat as missing.
		if (record.proposal_hash !== proposalHash) return undefined;
		return record;
	} catch { return undefined; }
}

function writeRecord(cwd: string, record: ApprovalRecord): string {
	const relativePath = join(APPROVALS_DIR, `proposal-${record.proposal_hash}.json`);
	const path = safeWorkspacePath(cwd, relativePath);
	mkdirSync(join(cwd, APPROVALS_DIR), { recursive: true, mode: 0o700 });
	writeFileSync(path, redactEvidence(JSON.stringify(record, null, 2)) + "\n", { mode: 0o600 });
	return path;
}

/** Create or refresh a PENDING approval request unless an identical valid approval already exists. */
export function requestApproval(cwd: string, proposal: ApprovalProposal, maxAgeMs = APPROVAL_MAX_AGE_MS_DEFAULT): ApprovalDecision {
	const proposalHash = proposalFingerprint(proposal);
	const existing = readRecord(cwd, proposalHash);
	if (existing?.status === "APPROVED" && !isExpired(existing)) {
		return { approved: true, status: "APPROVED", proposalHash, path: recordPath(cwd, proposalHash), reason: "Matching approval already recorded" };
	}
	const record: ApprovalRecord = {
		schema_version: 1,
		proposal_hash: proposalHash,
		title: redactEvidence(proposal.title),
		action: redactEvidence(proposal.action),
		scope: redactEvidence(proposal.scope),
		artifacts: (proposal.artifacts ?? []).map(artifact => redactEvidence(artifact)).slice(0, 20),
		status: "PENDING",
		created_at: new Date().toISOString(),
		run_id: proposal.runId ? redactEvidence(proposal.runId) : undefined,
		privacy: { redacted: true, scope: "workspace" },
	};
	const path = writeRecord(cwd, record);
	return { approved: false, status: "PENDING", proposalHash, path, reason: existing?.status === "REJECTED" ? "Prior proposal was rejected; re-requesting does not override that decision" : "Waiting for explicit human approval" };
}

/** Record the user's explicit decision for an exact proposal. Only the gate writes records. */
export function recordApproval(cwd: string, proposal: ApprovalProposal, approved: boolean, reason?: string, maxAgeMs = APPROVAL_MAX_AGE_MS_DEFAULT): ApprovalDecision {
	const proposalHash = proposalFingerprint(proposal);
	const now = new Date();
	const record: ApprovalRecord = {
		schema_version: 1,
		proposal_hash: proposalHash,
		title: redactEvidence(proposal.title),
		action: redactEvidence(proposal.action),
		scope: redactEvidence(proposal.scope),
		artifacts: (proposal.artifacts ?? []).map(artifact => redactEvidence(artifact)).slice(0, 20),
		status: approved ? "APPROVED" : "REJECTED",
		created_at: now.toISOString(),
		decided_at: now.toISOString(),
		expires_at: approved ? new Date(now.getTime() + maxAgeMs).toISOString() : undefined,
		reason: reason ? redactEvidence(reason) : undefined,
		run_id: proposal.runId ? redactEvidence(proposal.runId) : undefined,
		privacy: { redacted: true, scope: "workspace" },
	};
	const path = writeRecord(cwd, record);
	return { approved, status: record.status, proposalHash, path, reason: approved ? "Approval recorded for this exact proposal" : "Rejection recorded for this exact proposal" };
}

function isExpired(record: ApprovalRecord): boolean {
	if (!record.expires_at) return false;
	const expires = Date.parse(record.expires_at);
	return Number.isFinite(expires) && expires <= Date.now();
}

/** Fail-closed check: only a matching, unexpired APPROVED record passes. */
export function checkApproval(cwd: string, proposal: ApprovalProposal): ApprovalDecision {
	const proposalHash = proposalFingerprint(proposal);
	const record = readRecord(cwd, proposalHash);
	if (!record) return { approved: false, status: "MISSING", proposalHash, reason: "No approval record for this exact proposal" };
	const path = recordPath(cwd, proposalHash);
	if (record.status === "APPROVED") {
		if (isExpired(record)) return { approved: false, status: "STALE", proposalHash, path, reason: "Approval expired; re-approval required" };
		return { approved: true, status: "APPROVED", proposalHash, path, reason: "Matching unexpired approval" };
	}
	if (record.status === "PENDING") return { approved: false, status: "PENDING", proposalHash, path, reason: "Approval requested but not decided" };
	return { approved: false, status: "REJECTED", proposalHash, path, reason: "Proposal was explicitly rejected" };
}

/** Bounded listing for `/workflow approvals`; untrusted summary only. */
export function listApprovals(cwd: string): Array<Pick<ApprovalRecord, "proposal_hash" | "title" | "action" | "status" | "created_at" | "expires_at">> {
	const dir = join(cwd, APPROVALS_DIR);
	if (!existsSync(dir)) return [];
	const entries = readdirSync(dir).filter(name => /^proposal-[0-9a-f]{64}\.json$/.test(name)).slice(0, MAX_LISTED_APPROVALS);
	const listed: ReturnType<typeof listApprovals> = [];
	for (const name of entries) {
		try {
			const record = JSON.parse(redactEvidence(readFileSync(join(dir, name), "utf8"))) as ApprovalRecord;
			if (record?.schema_version === 1 && typeof record.proposal_hash === "string") {
				listed.push({ proposal_hash: record.proposal_hash, title: record.title, action: record.action, status: record.status, created_at: record.created_at, expires_at: record.expires_at });
			}
		} catch { /* Corrupt records are skipped, never crash the command. */ }
	}
	return listed;
}
