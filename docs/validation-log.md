# Plugin workflow validation log

Validation runs use `opencode-go/deepseek-v4-flash` with thinking level `low`.
Fixtures are isolated temporary Git projects driven through real Pi sessions in
Herdr. External RTK `npm test` behavior was excluded from product conclusions;
the authoritative fixture command is `node --test`.

## Rounds

| Round | Workflow | Result | Finding and disposition |
|---|---|---|---|
| 1 | PLAN | PASS after fix | Non-Git `show_report` blocks by design; recorded as an environment boundary. Planning writes also conflicted with the task gate; planning-artifact writes now bypass that gate. |
| 2 | PLAN | PASS | Fenced command assertions such as `[cmd] \`node --test\` → ...` were parsed incorrectly. Command extraction now removes code fences and trailing annotations. |
| 3 | SPEC | PASS after fix | Generated specs omitted executable `## Contract` assertions, so `show_report` could not complete. SPEC prompt now requires `[cmd]`, `[file]`, or `[match]` assertions. |
| 4 | TEAM | PASS after fix | Prompt referred to a Tester role absent from the available roster. TEAM now explicitly assigns verification/testing to Reviewer. |
| 5 | CHAIN | PASS | `plan-build-review` ran Planner → Builder → Reviewer and produced a real passing fixture. Reviewer surfaced unrelated pre-existing fixture issues; they were kept out of scope. |
| 6 | PIPELINE | PASS after fix | `set_mode PIPELINE` could race config/listener startup and leave no active pipeline. Pipeline activation now reconciles through an explicit cross-extension hook; phase flow and a set-mode-only race smoke pass. |
| 7 | NORMAL / PLAN / SPEC | PASS | A fake-child restart contract reopened an existing session with `-c`, closed the journal row, and preserved the parent run link for all three modes. This validates the shared dispatch boundary without claiming a live provider smoke. |
| 8 | NORMAL | PASS | Live `pi -p --mode json --no-session` smoke with `opencode-go/deepseek-v4-flash` in an isolated `/tmp` workspace returned `REAL-SMOKE-PASS`; no repository files were touched. |
| 9 | PLAN / SPEC | PASS | Live provider smoke called `set_mode` exactly once for each mode and returned `PLAN-SMOKE-PASS` / `SPEC-SMOKE-PASS`; no file inspection or mutation was requested. |
| 10 | TEAM / CHAIN / PIPELINE | PASS | Live provider smoke called `set_mode` exactly once for each mode and returned `TEAM-SMOKE-PASS`, `CHAIN-SMOKE-PASS`, and `PIPELINE-SMOKE-PASS`; no worker or file mutation was started. |
| 11 | NORMAL batch join | PASS | In an isolated `/tmp` workspace with the real provider, the parent called `subagent_create_batch` for two SCOUT workers and then one `subagent_wait`; both markers were present and the parent returned `BATCH-JOIN-SMOKE-PASS`. The workers intentionally omitted `## RESULT`, and the join preserved an explicit contract-violation warning rather than treating the output as verified evidence. |
| 12 | NORMAL batch join:true | PASS | In an isolated `/tmp` workspace with the real provider, one parent call to `subagent_create_batch` used `join:true` for two parallel SCOUT workers; no separate `subagent_wait` call occurred, the parent returned `JOIN-TRUE-SMOKE-PASS`, and both worker journal rows/transcript archives were retained. The `--no-session` smoke intentionally had no parent composition event directory. |
| 13 | NORMAL headless batch join:true | PASS | A repeat isolated `--no-session` real-provider smoke used one `join:true` batch call for two SCOUT workers and returned `HEADLESS-EVENTS-SMOKE-PASS`; the parent composition event directory contained run start, child starts/completions, usage, workspace delta, and terminal success. |
| 14 | NORMAL / PLAN / SPEC / TEAM / CHAIN / PIPELINE | PASS | Real `opencode-go/deepseek-v4-flash` entry smoke in six isolated `/tmp` workspaces: each session called `set_mode` exactly once and returned its mode marker. All 6/6 passed; wall time was 15.8–28.1s including Pi startup, with CHAIN the slowest. No worker was started and no repository file was modified, so this is entry-path evidence rather than full workflow-performance evidence. |

## Current evidence

- Full repository tests: 182 Bun passed; 954 Vitest passed; 13 skipped.
- Orchestration budget regression coverage confirms concurrent admission
  reservations are atomic, visible in status, released on actual usage, and
  explicitly releasable when a worker produces no usage; expired reservations
  are excluded from actual usage after TTL recovery.
- `compose_exec` now persists a bounded `step.completed` handoff payload, so a restarted parent can inspect completed-step output from the composition journal.
- `compose_exec` can execute the workspace-bounded built-in `read` with schema
  validation; traversal and symlink-escape attempts are rejected by the shared
  path boundary.
- `compose_exec` can execute the workspace-bounded built-in `write` with schema
  validation, rejects escaping parent symlinks, and blocks parallel read/write
  batches that share the workspace resource.
- `compose_exec` can execute exact-match built-in `edit`; ambiguous matches are
  rejected unless `replaceAll` is explicit, and successful replacements remain
  inside the workspace boundary.
- `compose_exec` can execute built-in `bash` with a bounded timeout schema;
  invalid timeouts are rejected and bash is not parallelized with workspace
  file operations.
- RunContext usage accounting persists token/cost deltas and a single
  `budget.exceeded` event; orchestration query summaries recover final usage
  after restart, and standard subagent completion feeds measured session usage
  into the owning run.
- Successful terminal status is forced to `failed` when measured token/cost or
  total-duration ceilings are exceeded, including a long single-step run.
- Shared budget check-and-append is protected by a cross-process lock, with a
  stale-lock recovery regression test.
- Live orchestration dashboard rows include bounded per-run token/cost usage;
  renderer regression coverage keeps the row within the requested width.
- `compose_exec` recovery regression resumes a stale checkpoint without
  re-running its completed step, and rejects terminal/active source runs.
- Exact orchestration status inspection includes bounded event payloads and
  supports slash-command lookup by run id plus `events <run_id>`.
- Batch dispatch guidance now supports a single-call `join: true` path for
  immediate parallel results, while preserving explicit background joins.
- Real provider smoke confirmed `join:true` performs parallel spawn plus one
  bounded join in a single parent call; worker contract warnings remain visible
  and are not promoted to verification evidence.
- Headless real-provider smoke confirmed the workspace fallback persists the
  parent composition event trail, including usage and terminal status.
- Mode-filter regression coverage confirms the query layer, status tool,
  slash command, and dashboard renderer agree on case-insensitive NORMAL,
  PLAN, SPEC, TEAM, CHAIN, and PIPELINE filtering.
- Dispatch-runtime regression coverage confirms a child run persists its
  initiating mode in the event journal; all standard and toolkit call sites
  now pass that metadata for leaf-level audit and filtering.
- Task-journal regression coverage confirms `/agents-status mode PLAN` uses
  the same case-insensitive filter without mutating persisted rows.
- Orchestration query/status regression coverage confirms mode metrics remain
  bounded and aggregate child/verification RunContext units by normalized
  mode, including success, failure, stale, duration, token, and cost fields.
- Dashboard renderer coverage confirms a mode-filtered view shows compact
  metrics while retaining the existing width bound and run-row details.
- Subagent lifecycle regression coverage confirms omitted timeouts use the
  shared 15-minute safety deadline while explicit zero still disables the
  watchdog for intentional long-running work.
- Static mode-path coverage confirms TEAM, CHAIN, and PIPELINE standard worker
  dispatches pass the shared 15-minute deadline into the transport runtime.
- Toolkit-worker regression coverage confirms the shared deadline applies to
  headless workers, terminates a timed-out child, and reports timeout as
  failure rather than cancellation.
- Toolkit-worker regression coverage also confirms timeout and cancellation
  return distinct structured failure causes for audit consumers.
- Subagent lifecycle regression coverage confirms synchronous scout/resume
  cancellation reaches the shared worker abort boundary, while detached batch
  joins retain their workers for later collection.
- Subagent lifecycle regression coverage confirms persisted batch recovery is
  read-only and returns explicit resume candidates instead of auto-replaying
  workers after restart; each candidate also carries bounded task context for
  an informed resume decision plus a bounded resumePrompt for explicit replay.
- Orchestration query regression coverage confirms an interrupted run retains
  Token/cost usage from its last persisted `usage.updated` event.
- `compose_exec` regression coverage confirms transient step errors retry at
  most three attempts, emit retry events, and expose the final attempt count;
  budget errors remain terminal.
- Capability registry regression coverage confirms discovered MCP tools are
  labelled `native_only`, while executor-backed extension capabilities are
  labelled `in_process` for composition and search consumers.
- Tool registry regression coverage confirms a tool loaded after session start
  becomes visible to the shared discovery index without weakening call-time
  security or approval gates.
- Executor registry regression coverage confirms an extension loaded after
  session start is both discoverable and invokable through `call_tool`.
- `call_tool` audit regression coverage confirms actual dynamic executions
  persist bounded tool lifecycle events and return a navigable RunContext id.
- The same audit coverage confirms an already-aborted call closes as
  `cancelled`, rather than being misclassified as a successful late result.
- Blocked `call_tool` regression coverage confirms self-reference rejection
  persists `tool.blocked` plus `run.failed`, returns a run id, and never invokes
  the target executor.
- Native tool audit coverage confirms direct tool lifecycles persist in
  NORMAL, PLAN, and SPEC with success/failure terminal states, while
  `call_tool` is excluded from duplicate outer accounting.
- Gate audit coverage confirms stacked native-tool rejection decisions are
  deduplicated by `toolCallId`, persist a bounded category/reason, and do not
  require or persist raw tool arguments.
- Query/dashboard coverage confirms tool name and terminal tool status are
  promoted into bounded run summaries for direct and blocked tool executions.
- Parent-topology coverage confirms a worker's direct tool run inherits the
  validated parent RunContext id and remains queryable as a child edge.
- Recovery projection coverage confirms stale compose runs return
  `compose-resume` through the read-only `orchestration_recover` tool without
  replaying or mutating the source run.
- Session-boundary coverage confirms blocked-call de-duplication resets on a
  new session, preventing reused request ids from suppressing fresh audit rows.
- Orchestration query regression coverage confirms a successful run without a
  verification receipt is explicitly projected as `UNVERIFIED`.
- `compose_exec` regression coverage confirms a slow step receives an abort
  signal at its bounded `timeout_ms` and becomes a failed step. A deliberately
  uncooperative executor is not retried after timeout, preventing duplicate
  side effects.
- Orchestration status/dashboard regression coverage confirms dispatch failure
  causes are projected into the read model and remain bounded for display.
- Journal rendering regression coverage confirms each linked task row exposes
  its persisted RunContext id for post-restart audit navigation.
- `/agents-status` now attributes runs by mode with bounded runs/success, elapsed,
  token, and cost fields; legacy journal rows remain included in global totals.
- `subagent_wait` cancellation returns structured `aborted` state without
  killing workers, preserving their journal entries for recovery.
- PLAN, SPEC, TEAM, CHAIN, and PIPELINE each completed a real Herdr smoke.
- SPEC completed through `show_spec` approval, `verify_execution PASS`, and `show_report` Done.
- PIPELINE completed `UNDERSTAND → PLAN → BUILD → REVIEW`, with `verify_execution PASS`.
- Live provider availability was checked with `pi auth check --no-refresh`; the isolated NORMAL, PLAN, and SPEC smoke runs completed successfully.
- The same isolated live mode-entry smoke completed for TEAM, CHAIN, and PIPELINE; worker execution remains covered by the fake-child dispatch matrix and prior Herdr workflow rounds.
- The isolated live NORMAL batch smoke verified real parallel spawn plus one bounded join; no repository files were touched.
- Batch lifecycle regression coverage confirms a synchronous `join: true` cancellation propagates the parent abort signal to every worker, while non-joined batches remain detachable background work.
- Full repository tests after the cancellation-boundary change: 172 Bun passed; 947 Vitest passed; 13 skipped. `doctor:strict`: 14 passed, 0 warnings/failures.
- Detached subagent lifecycle coverage now returns the persisted RunContext id from `subagent_create` and `subagent_wait`, keeping later audit and recovery queries linked to the original worker or batch.
- Team, Chain, and Pipeline structured results now retain only a bounded `outputPreview`; full worker transcripts remain on disk behind `fullOutputPath`, preventing large `details` payloads from re-entering the parent context.
- Full repository tests after structured-output bounding: 174 Bun passed; 948 Vitest passed; 13 skipped.
- TEAM, CHAIN, and PIPELINE entry-point results now return their parent RunContext id, so status, recovery, and audit tools can follow a direct structured link instead of parsing logs or result text.
- Full repository tests after entry-point run linking: 174 Bun passed; 949 Vitest passed; 13 skipped.
- NORMAL/PLAN/SPEC routing now recommends one bounded parallel SCOUT + researcher join when both independent evidence sources are already known, while preserving sequential dispatch when research depends on scout findings.
- Full repository tests after cross-mode reconnaissance routing: 174 Bun passed; 950 Vitest passed; 13 skipped.
- RunContext budget coverage now hard-blocks new steps after a token/cost ceiling is exceeded, while preserving the measured overage and terminal `run.failed` audit event.
- Full repository tests after RunContext budget enforcement: 174 Bun passed; 950 Vitest passed; 13 skipped.
- TEAM, CHAIN, and PIPELINE now propagate the parent tool AbortSignal into their worker transports; cancelling the primary orchestration call reaches standard Pi workers instead of only ending the parent wait.
- Full repository tests after cross-entry cancellation propagation: 174 Bun passed; 951 Vitest passed; 13 skipped.
- PIPELINE recovery now persists the completed phase handoff before returning and refuses a duplicate dispatch after restart; verifier-directed retry explicitly clears that guard so corrective re-execution remains possible.
- Full repository tests after pipeline duplicate-dispatch protection: 174 Bun passed; 951 Vitest passed; 13 skipped.
- CHAIN recovery now prefers a strong journal-backed completed step when the parent snapshot is one step behind, reusing only an exact task, post-snapshot completion, in-session archive, and successful terminal status; otherwise it safely re-runs the interrupted step.
- Full repository tests after journal-first chain recovery: 174 Bun passed; 951 Vitest passed; 13 skipped.
- TEAM now supports bounded concurrent independent dispatch through `dispatch_team_batch`, preserving one parent RunContext and per-worker audit links while retaining sequential `dispatch_agent` for dependent work.
- TEAM batch results now return only one-line worker summaries plus bounded archive pointers (hard cap 8,000 characters); full worker transcripts remain in the runtime archive.
- TEAM batch recovery now has a read-only `team_batch_recover` projection; stale TEAM batch RunContexts identify it through `orchestration_recover`, and only existing in-session worker files become explicit resume candidates.
- TEAM recovery candidate classification is now covered by fixture tests for completed, missing, out-of-root, and oversized-task journal rows rather than only source wiring.
- NORMAL/PLAN/SPEC single-worker dispatch now supports explicit `join: true` for immediate planner/builder/reviewer results, while scout/researcher/toolkit defaults and background behavior remain unchanged.
- TEAM batch dispatch/recovery are now registered in the shared task/approval gate matrix; regression coverage confirms dispatch requires an active task while recovery remains read-only.
- TEAM parent RunContexts now record measured child token/cost usage for single and batch dispatches, keeping status and mode metrics aligned with worker consumption.
- CHAIN and PIPELINE parent RunContexts now record measured child token/cost usage, including failed workers with persisted session usage.
- RunContexts now combine external cancellation with a run-owned signal and cancel synchronous worker groups after local or shared actual-spend budget exhaustion; reservations remain admission-only and do not interrupt workers that own their share.
- Resource-aware scheduling now parses optional PIPELINE resource keys and applies deterministic conflict-free waves to TEAM batches, subagent batches, and parallel PIPELINE phases; pure scheduler and parser regressions pass.
- Resource declarations and wave membership are now included in TEAM, PIPELINE, and subagent batch RunContext events for post-run auditability.
- Added `npm run eval:orchestration`: provider-free runtime evaluation passes independent parallel speedup, resource-conflict wave behavior, and budget cancellation; it explicitly reports that provider-backed six-mode metrics remain unmeasured.
- Tool registry regression confirms runtime-provided schemas are preserved on discovered native-only capabilities and cannot thereby become in-process executors.
- Real provider entry smoke for all six modes passed 6/6 in parallel isolated workspaces; the measured range includes process/provider startup and is not a substitute for task-matched workflow metrics.
- Session-switch source coverage confirms new sessions reset to NORMAL and stop
  CHAIN/PIPELINE-owned workers before replacement-session work can dispatch.
- Session-switch source coverage also confirms all session-owned viewer/server
  extensions close their local resources; the sounds viewer stops playback.
- PIPELINE recovery coverage confirms startup keeps worker session files when a
  valid phase snapshot matches the loaded configuration, while stale or
  incompatible snapshots still trigger bounded cleanup.
- TEAM startup cleanup now preserves the latest unfinished TEAM role session
  only when its journal row points to the expected in-root file; completed,
  invalid, and unrelated mode-owned files remain protected from accidental
  deletion. Full repository tests after this recovery-boundary fix: 183 Bun
  passed; 957 Vitest passed; 13 skipped.
- Phase 1 design confirmation is recorded in `PI_FABRIC_ADOPTION.md`, mapping
  the adopted capability, runtime, recovery, audit, and extension-boundary
  principles to the seven global goals and listing the deliberately excluded
  designs. TEAM session-retention policy is now independently covered by three
  pure-policy tests. Full repository tests after the phase-1 closeout: 183 Bun
  passed; 960 Vitest passed; 13 skipped.
- A Herdr journal E2E attempt exposed a harness weakness: it used the pane's
  `Working` text as completion evidence and had no explicit provider budget;
  the goodboy worker remained journaled as `running` within that wait window.
  The harness now waits for the worker's journal terminal state, reports the
  last row on timeout, and sets a conservative `/budget 16000 0.20` before
  dispatch. This is recorded as an inconclusive provider run, not a product
  pass or failure.
- The same journal E2E passed after adding the 15-second startup
  reconciliation grace: real Herdr Pi TUI workers survived the parent's fresh
  journal row, both breaker/goodboy rows reached terminal state, the contract
  warning and full archives were present, and the run was bounded by
  `/budget 16000 0.20`.
- Herdr handoff E2E passed with `PI_OFFLINE=1`: an isolated real Pi TUI
  discovered the unfinished handoff, rendered `/handoff` with its objective
  and next action, and preserved the durable snapshot without provider usage.
- A low-cost real Herdr PLAN task passed with `/budget 8000 0.10`: the TUI
  executed `set_mode → show_plan → result`, returned `PLAN-TASK-PASS`, made no
  file changes, and created no worker journal, confirming the interactive PLAN
  path without launching additional agents.
- A low-cost real Herdr SPEC task passed with `/budget 8000 0.10`: the TUI
  executed `set_mode → show_spec → result`, returned `SPEC-TASK-PASS`, ran no
  worker, and made no implementation changes in the disposable workspace.
- TEAM Herdr worker smoke reached the functional success state: the real TUI
  switched to TEAM, dispatched the valid `Reviewer` roster member, the child
  ran `printf team-ok`, the parent toggled task 1 to done, and displayed
  `TEAM-TASK-PASS` under `/budget 8000 0.08`. The harness initially waited
  unnecessarily because it matched journal agent names case-sensitively; it
  now normalizes that field. The UI trace also exposed excess task setup and
  dispatch noise, recorded as a UX follow-up rather than hidden.
- A bounded real Herdr CHAIN attempt reached `run_chain` after fixing the
  `originalTask` snapshot typo: Planner completed and Builder was dispatched,
  but the chain did not reach a verified terminal success because the worker
  result contract was malformed and the model drifted into a manual fallback.
  This is recorded as a failed/inconclusive CHAIN workflow, not a pass; the
  provider run was capped at `/budget 24000 0.20`.
- After adding the concise CHAIN handoff contract reminder, the same bounded
  real Herdr workflow passed: Planner → Builder → Reviewer completed as three
  terminal `chain` journal rows and the parent returned `CHAIN-TASK-PASS` under
  `/budget 24000 0.20`, without manual fallback or repository changes.
