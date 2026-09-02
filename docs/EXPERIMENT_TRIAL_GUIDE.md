# Experiment branch trial guide

This branch is intentionally isolated from `main`. Use it to compare the
workflow behavior with your usual Pi setup before deciding whether to merge.

## What to try

Run representative tasks in each mode, preferably against a disposable
workspace when the task can write files.

| Mode | Trial shape | What to observe |
|---|---|---|
| NORMAL | A small coding task, then a follow-up question | Does the task stay low-ceremony? Do optional scouts/researchers return compactly? |
| PLAN | A multi-file change with an approval checkpoint | Is the plan readable? Does approval bind to the exact plan before implementation? |
| SPEC | An unfamiliar feature with acceptance assertions | Are requirements, executable checks, and implementation gates clear? |
| TEAM | Two independent research or implementation workstreams | Do independent jobs run together while conflicting resources serialize? |
| CHAIN | A named planner → builder → reviewer flow | Does each step receive only the needed summary, with the transcript archived? |
| PIPELINE | A longer understand → plan → build → review task | Can the workflow advance, retry verification, and resume without duplicate dispatch? |

## Useful observability commands

During or after a run, inspect the shared runtime records rather than relying
only on the final model message:

- `/orchestration-dashboard` — live runs, mode metrics, budget, and stale work.
- `/orchestration-status` — bounded event timeline for a specific run.
- `orchestration_recover` tool — read-only recovery candidates and next actions.
- `/handoff` — the compact objective, task state, children, and next action.
- `/agents-status` — journal rows, elapsed time, token/cost data, and RunContext links.

For real-provider Herdr runs, set a conservative shared budget first, for
example `/budget 16000 0.20`. Treat the persisted journal terminal state as
authoritative; TUI text such as `Working` is only a progress hint.

## Feedback to record

For each task, capture:

```text
mode:
task shape:
worked as expected:
unexpected extra model turns:
parallelism or waiting issue:
recovery/cancellation issue:
token/cost concern:
audit information missing:
severity: cosmetic | inconvenient | blocks work | unsafe
```

The current synthetic evaluator is useful for scheduler and cancellation
regressions, but it does not prove provider token or cost savings. Those should
come from real tasks recorded in the journal. Keep the branch unmerged while
collecting that evidence.
