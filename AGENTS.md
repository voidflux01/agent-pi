# AGENTS.md — Project Rules (provider-neutral)

These rules apply to every coding agent working in this repository, regardless
of provider. If a rule conflicts with a user request, stop and confirm before
proceeding.

## Repository identity

- This repo is an agent-pi extension package. The only remote is `origin`
  (`voidflux01/agent-pi`), which is **public**. Everything pushed lands on the
  public internet.

## Git operations — strict policy

- **Never run `git push` without explicit user approval.** Before any push:
  1. State that you are about to push.
  2. Name the remote and branch.
  3. Confirm the repo visibility (`gh api repos/OWNER/REPO --jq '.visibility'`).
  4. Wait for explicit user approval.
- Always specify the remote by name; never use a bare `git push`.
- If visibility cannot be determined or the target is public without approval,
  REFUSE the push.
- Only commit files directly related to the current task; show `git status`
  before committing.

## Private content

- Only the `*/private/` subdirectories are private and must **NEVER** be pushed
  to any remote: `skills/private/`, `extensions/private/`,
  `commands/private/`.
- The main content of `agents/`, `extensions/`, and `prompts/` is already
  public on `origin`. Keep proprietary material out of the repository entirely,
  or under a `*/private/` path.
- A local pre-push hook (`.githooks/pre-push`, enabled via
  `git config core.hooksPath .githooks`) blocks private-path pushes and fails
  closed when `.private-patterns` is missing. Do not attempt to bypass it.

## CI

- `.github/workflows/verify.yml` is tracked and runs the full check gate on
  push/PR. It is intentional; keep CI workflows read-only and minimal
  (`permissions: contents: read`, no secrets in logs).

## Failed checks

- When a check fails during ordinary development, follow
  `docs/failed-check-triage.md`: reproduce → diagnose → repair the smallest
  owner → rerun the same check. Do not silently retry until green.
- The completion gate is the independent verifier receipt, never an agent's
  self-reported result.

## Confirmation required

Always require explicit user confirmation for: `git push` (any remote),
`git force-push`, changing repo visibility, publishing packages, and any action
that sends data to external services.