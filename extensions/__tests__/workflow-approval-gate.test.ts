import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkApproval, listApprovals, proposalFingerprint, recordApproval, requestApproval } from "../lib/workflow-approval-gate.ts";

const proposal = { title: "Fix auth token expiry", action: "apply log-triage fix", scope: "Edit extensions/lib/auth.ts lines 10-20", artifacts: ["extensions/lib/auth.ts"] };

function workspace(): string {
	return mkdtempSync(join(tmpdir(), "agent-pi-approval-"));
}

describe("workflow approval gate", () => {
	test("fail-closed without any record", () => {
		const cwd = workspace();
		const decision = checkApproval(cwd, proposal);
		expect(decision.approved).toBe(false);
		expect(decision.status).toBe("MISSING");
	});

	test("pending request does not authorize execution", () => {
		const cwd = workspace();
		const requested = requestApproval(cwd, proposal);
		expect(requested.approved).toBe(false);
		expect(requested.status).toBe("PENDING");
		const checked = checkApproval(cwd, proposal);
		expect(checked.approved).toBe(false);
		expect(checked.status).toBe("PENDING");
	});

	test("recorded approval passes only for the exact proposal", () => {
		const cwd = workspace();
		recordApproval(cwd, proposal, true, "user confirmed in session");
		expect(checkApproval(cwd, proposal).approved).toBe(true);
		const changed = checkApproval(cwd, { ...proposal, scope: "Edit extensions/lib/auth.ts lines 10-25" });
		expect(changed.approved).toBe(false);
		expect(changed.status).toBe("MISSING");
	});

	test("any proposal change invalidates the fingerprint binding", () => {
		const cwd = workspace();
		recordApproval(cwd, proposal, true);
		expect(proposalFingerprint(proposal)).not.toBe(proposalFingerprint({ ...proposal, title: "Fix auth token expiry " }));
		expect(proposalFingerprint(proposal)).not.toBe(proposalFingerprint({ ...proposal, action: "apply different fix" }));
		expect(proposalFingerprint(proposal)).not.toBe(proposalFingerprint({ ...proposal, artifacts: ["other.ts"] }));
	});

	test("expired approvals fail closed as STALE", () => {
		const cwd = workspace();
		recordApproval(cwd, proposal, true, undefined, -1);
		const decision = checkApproval(cwd, proposal);
		expect(decision.approved).toBe(false);
		expect(decision.status).toBe("STALE");
	});

	test("rejection stays sticky across re-requests until explicit re-approval", () => {
		const cwd = workspace();
		recordApproval(cwd, proposal, false, "scope too broad");
		expect(checkApproval(cwd, proposal).status).toBe("REJECTED");
		const reRequested = requestApproval(cwd, proposal);
		expect(reRequested.status).toBe("PENDING");
		expect(checkApproval(cwd, proposal).approved).toBe(false);
		recordApproval(cwd, proposal, true, "narrowed after user feedback");
		expect(checkApproval(cwd, proposal).approved).toBe(true);
	});

	test("records are redacted and workspace-bounded", () => {
		const cwd = workspace();
		const decision = recordApproval(cwd, { ...proposal, scope: "Edit auth.ts token=\"supersecret\" user@corp.com" }, true);
		const content = readFileSync(decision.path!, "utf8");
		expect(content).toContain("[REDACTED]");
		expect(content).toContain("[REDACTED EMAIL]");
		expect(content).not.toContain("supersecret");
	});

	test("listing is bounded and skips corrupt records", () => {
		const cwd = workspace();
		recordApproval(cwd, proposal, true);
		writeFileSync(join(cwd, ".pi/workflow/approvals/proposal-bad.json"), "{not json");
		const listed = listApprovals(cwd);
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({ status: "APPROVED", title: "Fix auth token expiry" });
		expect(listApprovals(mkdtempSync(join(tmpdir(), "agent-pi-empty-")))).toEqual([]);
	});
});
