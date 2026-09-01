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
- `orchestration_status` and `/orchestration-status` read the same persisted
  run events used by dispatch, toolkit, and composition paths.
- TEAM, CHAIN, and PIPELINE now emit parent orchestration runs; their child
  dispatch records carry `parentRunId`, so the execution graph can be rebuilt
  after a restart.
- The query layer exposes a bounded topology read model with explicit edges and
  orphan/cycle diagnostics; `/orchestration-status tree` renders it without
  recursively trusting persisted data.
- Non-terminal runs carry a PID-backed `active.json` lease. The status view
  reports `running` only while that process is alive and otherwise reports
  `stale`, making crashed runs visible without silently rewriting their event
  history.
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

1. Extend RunContext events to TEAM, CHAIN, and PIPELINE dispatch.
2. Exercise `compose_exec` with mocked extension handlers and approval/security
   rejection cases before exposing more capabilities.
