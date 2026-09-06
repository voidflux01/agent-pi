# agent-pi coding-agent foundations

This document explains the operating contract of the Pi extension. It is guidance for the agent and the person reviewing its work; it does not replace Pi's own system prompt, permissions, or project rules.

## Context and permissions

Pi searches the workspace with its native read tools and builds the current turn from selected files, tool results, and compacted session history. `subagent` and workflow tools create additional execution boundaries: their prompts and returned summaries consume context, while the child environment receives only the capabilities explicitly projected to it. MCP and other extensions remain subject to Pi's tool and approval gates; discovering a capability does not grant permission to execute it.

`AGENTS.md` and `CLAUDE.md` are treated as project evidence with an explicit conflict warning. `context_draft` only reads bounded manifests, rules, and directory facts. It produces a draft and fingerprints, never silently edits a rule file or turns an inference into a standing instruction.

## Modes and workflow choice

- `NORMAL`: short, low-risk work with ordinary task tracking.
- `PLAN`: inspect and propose a plan; implementation requires explicit plan approval.
- `SPEC`: clarify requirements and acceptance criteria before implementation.
- `TEAM`: parallel specialist work when the task naturally separates into independent scopes.
- `CHAIN`: ordered handoffs where each step depends on the previous result.
- `PIPELINE`: named phases for longer work such as understand → plan → build → review.

Risk, uncertainty, scope, and cost should determine the mode. When evidence contradicts the plan, the agent should use `workflow_advice`: implementation failures normally return to BUILD, assumption failures to PLAN, requirement failures to SPEC, and repeated attempts require human input.

## Long-horizon safety

Every delegated run has bounded steps, duration, tokens, cancellation, and recovery state. A timeout or stale worker is not a successful result. Parent-visible handoffs stay compact and point to bounded evidence; complete transcripts remain in the local session archive. Parallel work is scheduled by declared resources so conflicting scopes are serialized.

## Verification and human gates

`verify_execution` is the deterministic acceptance boundary. Eval results are additional evidence and never mark a user task complete. Evidence is untrusted, bounded, redacted where possible, and referenced by stable identifiers. High-risk workflow actions use `workflow_approval`; an approval record authorizes only the exact scope and does not itself execute, deploy, or modify files.

Deployment checks report readiness only. Missing, failed, unavailable, or uncited required checks block readiness. The extension does not become a CI/CD system, monitoring daemon, or automatic deployment service.

## Budget and recovery semantics

Token budgets use measured uncached usage where available; reservations are not treated as spend until usage is recorded. Cancellation propagates to child work. Recovery is resume-or-replan based on persisted state and evidence, never blind replay. A retrospective may record hypotheses, uncertainties, and evidence references, but rule updates remain reviewable drafts.
