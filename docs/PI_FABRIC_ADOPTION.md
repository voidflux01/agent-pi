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
- The workspace-bounded built-in `read`, `write`, and exact-match `edit`
  capabilities can participate in `compose_exec` with schema validation; write
  operations reject traversal and symlink escapes, edit rejects ambiguous
  matches by default, and all share the existing approval/security path.
- The built-in `bash` capability can participate in `compose_exec` with an
  explicit command/timeout schema. It reuses nested security and approval
  checks, caps timeout input, and is conservatively ordered against workspace
  operations so potentially mutating commands are not parallelized.
- Nested arguments are validated against the registered capability schema before
  execution, and parallel batches are rejected when non-commutative effects
  share a resource.
- `/budget <max_tokens> <max_cost_usd>` enables an opt-in shared JSONL ledger;
  journaled worker usage is deduplicated into it, and dispatch preflight blocks
  new workers after the ceiling is reached.
- `RunContext` now records measured token/cost deltas as `usage.updated`, emits
  one durable `budget.exceeded` event when an optional per-run ceiling is
  crossed, and includes the final usage in the terminal run event. Standard
  subagent and batch dispatches feed their session usage into this parent run.
- A run that crosses its token/cost ceiling or total-duration ceiling cannot
  finish as `succeeded`; the runtime records the breach and forces a failed
  terminal state, keeping status and budget evidence consistent.
- The shared token/cost ledger serializes check-and-append across processes
  with a short-lived lock and stale-lock recovery, so parallel workers cannot
  pass the same preflight based on an outdated total.
- The live orchestration Activity dashboard now shows bounded per-run
  token/cost usage alongside status, duration, verification, and recovery
  information, making mode-level efficiency differences visible during work.
- The shared orchestration query now supports case-insensitive mode filters;
  `orchestration_status` accepts `mode`, `/orchestration-status mode PLAN`
  supports list/tree inspection, and `/orchestration-dashboard mode PLAN`
  narrows the live Activity view. NORMAL, PLAN, SPEC, TEAM, CHAIN, and
  PIPELINE therefore use the same observability path rather than separate
  mode-specific dashboards.
- `compose_exec` persists a bounded composition plan and supports explicit
  `resume_run_id` recovery for stale runs: completed steps and their compact
  results are reused, while only unfinished steps are executed in a new linked
  run. Active or terminal source runs are rejected instead of replayed.
- Exact `orchestration_status` inspection now renders bounded event payloads,
  including handoffs, verification, and budget records; the slash command also
  accepts a run id or `events <run_id>` for the same read-only view.
- Headless contexts without a Pi session file now persist parent orchestration
  events under the workspace's `.pi/agent-sessions/compositions` directory,
  keeping no-session worker topology and recovery inspectable.
- Composition returns bounded structured step results instead of forwarding
  every intermediate tool payload.
- Task journal rows now carry the initiating mode when known, and
  `/agents-status` aggregates elapsed time, tokens, and cost by mode so a
  NORMAL / PLAN / SPEC / TEAM / CHAIN / PIPELINE baseline can be measured from
  the same durable evidence.
- `subagent_create` and its standard background dispatch path now create a
  parent orchestration run, so NORMAL, PLAN, and SPEC scouts/builders appear in
  the same parent/child topology as TEAM, CHAIN, and PIPELINE workers.
- `subagent_create_batch` gives a parallel batch one bounded parent run and
  aggregates child success/failure/cancellation before closing it, preserving
  one auditable unit for independent work.
- `subagent_wait` provides an explicit bounded join for background batches:
  child results stay in the runtime until requested, then one capped summary is
  returned to the parent. This keeps parallel work useful in NORMAL, PLAN, and
  SPEC as well as TEAM without creating one follow-up turn per child. Both
  tools also return bounded IDs, parent `runId`, terminal statuses, and timeout
  state for machine-readable recovery and audit.
- `subagent_create_batch` accepts `join: true` when the parent needs results
  immediately; parallel spawn and the bounded join then happen in one tool
  call, while the default background behavior remains unchanged.
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
- The same mode metadata now propagates to standard and toolkit child runs,
  so mode-filtered status and parent/child audit graphs retain the initiating
  mode at the leaf worker instead of only on the coordinator.
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
- NORMAL, PLAN, and SPEC can now recover a finished or interrupted standalone
  subagent from its persisted journal dispatch id via `subagent_resume` or
  `/subresume`; the existing session is explicitly reopened with `-c` and the
  same worker/runtime audit path is reused.
- `orchestration-dashboard.ts` adds an opt-in/live TUI Activity widget with
  recent run status and shared budget consumption; it refreshes in place and
  stops its timer on session lifecycle changes.

## Deliberately deferred

- QuickJS guest execution: the first composition surface is host-side and only
  runs already registered extension handlers.
- Remaining built-in Pi tool proxying is limited to tools without an equivalent
  in-process executor. `read`, `write`, exact-match `edit`, and security-checked
  `bash` adapters are available; native tools still remain available directly.
- Actors, councils, recursive workers, and a full cross-process topology: the
  current dashboard is a stable read model, but the underlying worker graph
  still needs every actor to emit the same `RunContext` events.

## Next validation gates

1. Collect repeated, task-matched runs for NORMAL, PLAN, SPEC, TEAM, CHAIN, and
   PIPELINE; compare the shared journal's average elapsed time, success rate,
   tokens, and cost before changing dispatch policy.
2. Exercise `compose_exec` with mocked extension handlers and approval/security
   rejection cases before exposing more built-in capabilities. The current
   read/write adapters cover workspace containment, symlink escape, and shared
   resource conflict cases.
3. Evaluate whether built-in Pi tools should publish capability descriptors, or
   remain on the native tool path until their security and schema contracts are
   equally explicit.
