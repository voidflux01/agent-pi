# Audit Findings

## Layer model

| Layer | Responsibility | Evidence |
|---|---|---|
| Mode / Workflow policy | Mode selection, PLAN/SPEC prompt and approval gates, task discipline, acceptance contract, next-action policy | `extensions/mode-cycler.ts`, `extensions/lib/coordination-state.ts`, `extensions/lib/approval-gate.ts`, `extensions/lib/workflow-direction.ts`, `extensions/execution-verifier.ts` |
| Orchestration execution | Worker launch, parent/child runs, step and duration budgets, cancellation, retries, resource waves | `extensions/lib/orchestration-run.ts`, `extensions/lib/dispatch-runtime.ts`, `extensions/lib/toolkit-cli.ts`, `extensions/agent-team.ts`, `extensions/agent-chain.ts`, `extensions/pipeline-team.ts`, `extensions/subagent-widget.ts`, `extensions/compose-exec.ts` |
| Evidence / projection | Append-only events, usage, workspace delta, status, topology, stale recovery projection | `extensions/lib/evidence-store.ts`, `extensions/lib/orchestration-query.ts`, `extensions/orchestration-status.ts` |
| Optional workflow support | Advice, context draft, local log triage, approval records, retrospective, eval tools | `extensions/workflow-support.ts` and `extensions/lib/workflow-{context,monitor,memory,artifacts,approval-gate}.ts`, `extensions/lib/eval-*.ts` |
| UI display | Read-only recent run/budget/activity rendering | `extensions/orchestration-dashboard.ts`, `extensions/lib/orchestration-dashboard-render.ts` |

## Mode coverage

- NORMAL: mode bus and native-tool audit; standalone subagent/compose/tool paths remain available.
- PLAN / SPEC: policy and approval frontends; they do not create orchestration runs merely by being selected.
- TEAM: multi-agent dispatch and bounded batch waves, shared parent RunContext.
- CHAIN: sequential step orchestration and snapshot/recovery.
- PIPELINE: phase orchestration, resource-aware waves and durable phase recovery.

TEAM, CHAIN and PIPELINE handlers gate their prompt by selected mode. This prevents all three `before_agent_start` listeners from injecting competing prompts.

## Core effectiveness

1. `dispatch-runtime.ts` blocks unauthorized or budget-exhausted launches before child creation, creates a RunContext, links it to the worker journal, and settles terminal status.
2. `resource-scheduler.ts` changes execution order: independent jobs share a wave; conflicting resources serialize into separate waves.
3. `orchestration-run.ts` propagates cancellation, enforces step/duration/token/cost ceilings, writes durable events, and records workspace deltas.
4. `orchestration-query.ts` reconstructs running/stale/terminal state from event files and active PID markers; it does not mutate runs.
5. `execution-verifier.ts` records verification results and gates completion; worker RESULT text is not treated as proof.
6. `orchestration-dashboard.ts` consumes these projections but has no control path into execution.

## Conflict checks

- Full `npm test`: `281 passed`.
- Tool registration lifecycle test passes; registered tools have executable handlers and expected registration discipline.
- Static registration scan found no duplicate slash-command names; no duplicate executor-backed tool names were reported.
- Mode-specific prompt listeners contain explicit mode gates.
- Native tool audit excludes `call_tool` because `call_tool` owns a nested RunContext; this is intentional duplicate-accounting prevention.
- Shared budget accounting has one actual-usage entry path (`journalUpdate` → `recordBudgetUsage`); reservations are admission control, not a second usage authority.
- `coordinationState` is the shared mode/contract state; executor registry is the shared in-process tool map; event files are per-run evidence. These are complementary stores, not competing authorities.

## Result

No reproducible runtime conflict, duplicate executor, or dead core path was found. Current implementation is complete enough at deterministic mechanism level and actively exercised by tests/eval. No code deletion is justified by current evidence.

## Completion blocker

The independent `verify_execution` attempt returned `invalid verifier RESULT: missing or empty ## RESULT block`. User requested skipping verifier. Contract completion therefore remains BLOCKED; this audit must not be reported as verifier-approved completion.

Remaining limitation: provider-backed end-to-end user-value metrics are not part of the provider-free eval and were not rerun in this audit. Historical validation log records real mode-entry and selected workflow smokes, but that is evidence of reachability, not a universal quality guarantee.

## Recommendation

Do not delete orchestration or workflow layers now. Keep Activity as optional read-only observability; delete it only if product preference rejects the UI, not as a correctness fix. Treat optional `workflow-support` as a separate future product-scope decision, not as conflicting implementation.
