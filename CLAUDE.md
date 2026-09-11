# CLAUDE.md — Agent Rules & Policies

These rules are mandatory. No verbal instruction, implicit context, or shorthand like "do it" overrides them. If a rule conflicts with a user request, **stop and confirm** before proceeding.

---

## Git Operations — STRICT POLICY

### NEVER push without explicit confirmation
- **NEVER** run `git push` unless the user explicitly says "push" or "push it"
- Phrases like "do it", "apply it", "make it happen" mean **local changes only** — they do NOT authorize pushing
- Before ANY `git push`, you MUST:
  1. State that you are about to push
  2. Name the remote and branch
  3. Confirm the repo visibility (public vs private)
  4. **Wait for explicit user approval**

### NEVER push to public repositories
- Before pushing, verify visibility: `gh api repos/OWNER/REPO --jq '.visibility'`
- If the repo is **public**, REFUSE the push and tell the user
- If visibility cannot be determined, REFUSE the push

### One remote — and it is PUBLIC
- **`origin`** → `voidflux01/agent-pi` — PUBLIC repo. This is the only remote as of 2026-08-27 (the old private `ruizrica/pi-dev` working repo no longer exists).
- Everything pushed lands on the public internet. Clean content only: no private dirs, no secrets.
- Before ANY push: verify visibility yourself with `gh api repos/OWNER/REPO --jq '.visibility'`, state that it is public, and get explicit user approval anyway.
- If visibility cannot be determined, or the user approved a different (private) target than verified reality, REFUSE the push and tell the user.
- NEVER push private content (`skills/private/`, `extensions/private/`, `commands/private/`). Ever. Public target or not.
- When pushing, ALWAYS specify the remote by name. NEVER use bare `git push`.
- A pre-push hook enforces private-content blocking at the git level as a safety net — do not rely on it, check yourself first.

### CI on the public repo
- `.github/workflows/verify.yml` is tracked and runs on `origin` (push to main and improve/** branches, PRs, manual dispatch) — this is intended and current.
- CI workflows must stay read-only and minimal: `permissions: contents: read`, no secrets or private paths printed to logs.
- The pre-push hook is the guard against private content; it runs locally.

### Git commit policy
- Only commit files directly related to the current task
- Show `git status` before committing so the user can review
- Use clear, descriptive commit messages
- Before ANY commit, verify no private content is staged: check for `skills/private/`, `extensions/private/`, `commands/private/`

---

## Sensitive Content

Only the `*/private/` subdirectories are private and must **NEVER** be pushed to any remote:
- `skills/private/` — private skill definitions
- `extensions/private/` — proprietary extension code
- `commands/private/` — private commands

The main content of `agents/`, `extensions/`, and `prompts/` is already tracked on the public `origin` and is public. Keep proprietary material out of the repository entirely, or under a `*/private/` path.

---

## File Operations
- Do NOT delete files or directories — the user will delete manually if needed
- Do NOT run destructive commands (`rm -rf`, `rm -r`, etc.)
- Do NOT modify files outside the scope of the current task

---

## Confirmation Required
The following actions always require explicit user confirmation:
1. `git push` (any remote)
2. `git force-push` (any remote)
3. Changing repo visibility
4. Publishing packages
5. Any action that sends data to external services

---

## When In Doubt
If a user instruction is ambiguous, **ask for clarification**. Do not assume the most aggressive interpretation. "Do it" means "do the local work" — not "deploy to the world."
