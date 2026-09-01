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

## Current evidence

- Full repository tests: 131 Bun passed; 942 Vitest passed; 13 skipped.
- PLAN, SPEC, TEAM, CHAIN, and PIPELINE each completed a real Herdr smoke.
- SPEC completed through `show_spec` approval, `verify_execution PASS`, and `show_report` Done.
- PIPELINE completed `UNDERSTAND → PLAN → BUILD → REVIEW`, with `verify_execution PASS`.
- Live provider availability was checked with `pi auth check --no-refresh`; the isolated NORMAL, PLAN, and SPEC smoke runs completed successfully.
