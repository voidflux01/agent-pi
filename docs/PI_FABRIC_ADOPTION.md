# Pi Fabric design adoption

This branch experiments with the parts of `pi-fabric` that fit agent-pi's
extension-first architecture. The goal is to improve composition and
observability without replacing the existing task, approval, security, and
worker lifecycle boundaries.

## Adopted in this iteration

- Every tool registered through `registerToolWithExecutor` publishes a
  namespaced `extensions.<tool>` capability descriptor.
- Descriptors carry an input schema, inferred or explicit risk, and a coarse
  effect/resource declaration. This gives discovery, approval, and future UI a
  shared vocabulary.
- `compose_exec` executes registered extension capabilities in sequence or in
  parallel, caps a batch at 16 steps, blocks meta-tool recursion, and reuses
  the existing nested security and approval gates.
- Nested arguments are validated against the registered capability schema before
  execution, and parallel batches are rejected when non-commutative effects
  share a resource.
- `/budget <max_tokens> <max_cost_usd>` enables an opt-in shared JSONL ledger;
  journaled worker usage is deduplicated into it, and dispatch preflight blocks
  new workers after the ceiling is reached.
- Composition returns bounded structured step results instead of forwarding
  every intermediate tool payload.
- `subagent_create` and its standard background dispatch path now create a
  parent orchestration run, so NORMAL, PLAN, and SPEC scouts/builders appear in
  the same parent/child topology as TEAM, CHAIN, and PIPELINE workers.
- `subagent_create_batch` gives a parallel batch one bounded parent run and
  aggregates child success/failure/cancellation before closing it, preserving
  one auditable unit for independent work.
- Audited parent runs can capture a bounded before/after workspace manifest;
  the event trail records changed file paths and hashes alongside the run
  result, while excluding the runtime's `.pi` bookkeeping files.
- `verify_execution` now emits `verification.started` and
  `verification.completed` events with deterministic PASS/FAIL/BLOCKED status
  and assertion counts, so successful worker output cannot be confused with
  successful validation.
- Exact `orchestration_status` queries can opt into a bounded event timeline
  with `include_events`, keeping normal status responses small while making
  targeted restart and audit inspection self-contained.
- Run summaries carry the initiating operational mode explicitly, so NORMAL,
  PLAN, SPEC, TEAM, CHAIN, and PIPELINE executions can be compared without
  inferring mode from actor names.
- Tool discovery projects built-in and `mcp__*` tools into the capability
  catalog for shared search, risk labels, and approval decisions; native tools
  remain on Pi's native execution path and are intentionally not made
  compose-able without an in-process executor.
- Non-terminal summaries expose `recovery: "stale"` and the last persisted
  event type, making a post-restart run actionable: inspect the bounded event
  timeline before deciding whether to resume or re-dispatch.
- Sequential composition supports bounded `$STEP_n_TEXT` and
  `$STEP_n_DETAILS.path` handoffs plus status-based `when` skips; references
  and conditions are rejected in parallel mode instead of creating implicit
  races.
- `orchestration_status` and `/orchestration-status` read the same persisted
  run events used by dispatch, toolkit, and composition paths.
- All six modes now use parent orchestration runs for their supported worker
  dispatch paths; child dispatch records carry `parentRunId`, so the execution
  graph can be rebuilt after a restart.
- The query layer exposes a bounded topology read model with explicit edges and
  orphan/cycle diagnostics; `/orchestration-status tree` renders it without
  recursively trusting persisted data.
- Non-terminal runs carry a PID-backed `active.json` lease. The status view
  reports `running` only while that process is alive and otherwise reports
  `stale`, making crashed runs visible without silently rewriting their event
  history.
- PIPELINE now writes an atomic versioned workflow snapshot; `/pipeline-resume`
  restores the phase, accumulated context, plan/review output, and review-loop
  counters only when the current config still matches the snapshot.
- CHAIN now writes a bounded atomic step snapshot; an interrupted chain keeps
  its worker sessions and can be continued with `/chain-resume` from the first
  unfinished step after a parent restart.
- `orchestration-dashboard.ts` adds an opt-in/live TUI Activity widget with
  recent run status and shared budget consumption; it refreshes in place and
  stops its timer on session lifecycle changes.

## Deliberately deferred

- QuickJS guest execution: the first composition surface is host-side and only
  runs already registered extension handlers.
- Built-in Pi tool proxying: built-ins continue through Pi's native path until
  their schemas and executors can be exposed through the same registry.
- Actors, councils, recursive workers, and a full cross-process topology: the
  current dashboard is a stable read model, but the underlying worker graph
  still needs every actor to emit the same `RunContext` events.

## Next validation gates

1. Add explicit end-to-end smoke coverage for NORMAL, PLAN, and SPEC worker
   dispatches, including restart/status reconstruction.
2. Exercise `compose_exec` with mocked extension handlers and approval/security
   rejection cases before exposing more built-in capabilities.
3. Evaluate whether built-in Pi tools should publish capability descriptors, or
   remain on the native tool path until their security and schema contracts are
   equally explicit.
