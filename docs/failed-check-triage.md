# Failed Check Triage

When a check fails during ordinary development (vitest, typecheck, test suite,
audit, package smoke), do **not** silently retry until green. A retry pass
without diagnosis is not repair evidence.

## The four steps

1. **Reproduce.** Run the same check again and keep its identity, the exact
   command, the working directory, and the failure output.
2. **Diagnose.** Localize the cause from attributable diagnostics: the failing
   assertion or error message, the changed files it points at, and any relevant
   logs. Name the causal hypothesis in one sentence.
3. **Repair the smallest owner.** Fix the smallest file or module that owns the
   cause. Do not expand the change to unrelated files.
4. **Revalidate.** Rerun the same check on the repaired final state and record
   that it is the same check and that it now passes. If the same check cannot
   run, record why the chosen equivalent covers the same behavior and scope.

## Escalation to the acceptance layer

- If the failing gate is the completion gate (the verifier receipt path), do
  not triage it with local retries. Follow `docs/verification-design.md`:
  INCONCLUSIVE is **BLOCKED** → escalate to a human. Never swallow an
  undecidable result as a pass.
- If a reproduction or diagnosis is impossible within the evidence available,
  keep the check unresolved and say so; do not mark the work complete.

## Red lines (do not cross)

- Do not revive inline command gates (`[cmd]`) — see
  `docs/verification-design.md` §5. Deterministic evidence goes through
  `[eval]` bindings.
- An agent's self-reported RESULT is never completion evidence; only the
  verifier receipt decides completion.
- Do not modify the workspace manifest or dependencies to make a check pass;
  that is a blocked (reward-hacking) signal, not a repair.