# Task Journal — Durable Sub-Agent Tracking

Every sub-agent dispatch in agent-pi is recorded in a durable, on-disk journal that survives parent restarts. This document covers the journal format, the `/agents-status` command, transcript archives, retention, restart reconciliation, the RESULT contract gate, and `ask_parent` questions.

## Where Things Live

| Path | Purpose |
|---|---|
| `<project>/.pi/agent-sessions/task-journal.jsonl` | The journal. One JSON object per line. |
| `<project>/.pi/agent-sessions/outputs/<id>.txt` | Full transcripts archived at dispatch completion. |
| `<project>/.pi/agent-sessions/asks/<id>.json` | One open/answered `ask_parent` question per file. |
| `<project>/.pi/agent-sessions/herdr-workspaces.json` | Ledger of herdr workspaces created by agent-pi. |

All paths are relative to the project directory Pi runs in. Nothing lives in `$HOME` except real Pi sessions (`~/.pi/agent/sessions/subagents/*.jsonl`).

## Journal Entries

Four dispatch paths write to the same journal:

| `kind` | Dispatched by |
|---|---|
| `sa` | Single sub-agent (spawn_agent tool / subagent widget) |
| `team` | Agent team members |
| `chain` | Agent chain stages |
| `pipeline` | Pipeline stage agents |

Each row goes through a small lifecycle: `dispatched` → `running` → `done` or `error`. A crashed parent's orphaned rows are closed by reconciliation (see below), never left dangling forever.

Entry fields (version 1):

```jsonc
{
  "version": 1,
  "id": "sa12-ab3d",            // stable per-run id; matches the archive base name
  "kind": "sa",
  "agent": "scout",              // display name of the sub-agent
  "task": "Recon the auth flow", // bounded to 4000 chars on disk
  "model": "...",                // when known
  "usage": {                     // summed from the Pi session file at finish
    "input": 1200, "output": 340,
    "cacheRead": 8100, "cacheWrite": 0,
    "totalTokens": 9640, "costUsd": 0.002037
  },
  "cwd": "/path/to/project",
  "sessionFile": "~/.pi/.../subagent-N-<ts>.jsonl", // enables -c resume
  "outputFile": "<cwd>/.pi/agent-sessions/outputs/sa12-ab3d.txt",
  "pid": 48211,                  // headless runs only
  "status": "done",
  "exitCode": 0,
  "elapsedMs": 45230,
  "startedAt": 1756250000000,
  "updatedAt": 1756250045230,
  "resumed": false,              // true when this dispatch resumed (-c)
  "note": "reconciled after crash" // human note set by reconciliation or gates
}
```

The `task` field never enters model context — it exists so a human can audit what was asked and why.

## /agents-status

```
IN-FLIGHT:
  RUNNING    sa12-ab3d pid:alive 12s session:/…/subagent-5-….jsonl
RECENT:
  DONE       sa11-f01c        45s 9,640tok (84% cached) $0.0021 session:/…
  ERROR      pl09-9d2a        8s  [result contract: no ## RESULT block]
  TOTAL (2 runs): 14,102 tokens, $0.0031
Journal: /path/to/project/.pi/agent-sessions/task-journal.jsonl
```

- **IN-FLIGHT** — rows still `dispatched`/`running`, with liveness from the recorded pid.
- **RECENT** — the last ten finished rows (`done`/`error`), oldest first as they appear in the journal.
- **TOTAL** — aggregated tokens/cost across those finished rows.
- Rows carry usage only when the run produced assistant messages; `$0.0021`-style costs mean under one cent (shown with 4 decimals below $0.01).
- The global summary also appends bounded per-mode metrics in the form
  `MODE:runs/ok/fail/average-seconds/tokens/cost`; rows written before mode
  attribution remain in the global totals and are omitted from the mode groups.

## Retention — 7-Day Rolling Window

On every extension start (`session_start`), `pruneRunArtifacts()` applies a single cutoff of **now − 7 days**:

1. Deletes `outputs/*.txt` transcripts older than the cutoff (file mtime).
2. Rewrites the journal atomically (write `.tmp`, rename) dropping rows whose `updatedAt` predates the cutoff. Unrecognized lines are preserved, never dropped silently.

Recent work is never touched; fresh archives are minutes old by definition. Raw Pi session files under `$HOME` follow Pi's own housekeeping, not this window.

## Restart Reconciliation

On the same startup pass, `reconcileJournal()` closes rows orphaned by a crashed parent. Classification for each stale `dispatched`/`running` row:

- Full transcript already on disk (archive or last assistant text) **with a RESULT marker** → closed as `done`.
- Headless run whose recorded pid is still alive → untouched.
- Session file still being written (mtime inside the active window) → untouched; a live sibling parent owns it.
- Anything else → closed as `error` with note `reconciled …`.

This is deliberately evidence-based: a row is only marked done if its work actually finished on disk.

## RESULT Contract Gate

A finished sub-agent transcript must end with an exact closing block:

```
## RESULT
done: true
summary: Auth flow mapped; 3 files touched; rate limiting still missing.
- key detail lines (free-form)
remaining: optional open items
## END
```

The gate checks pure mechanics, zero tokens required:

| Problem | Meaning |
|---|---|
| `no ## RESULT block` | No closing block found |
| `block not closed with ## END` | Block left open |
| `missing "done:" line` | No `done:` true/false line inside the block |
| `missing "summary:"` | No non-empty summary line |

When violated, the composed result shown to the parent gets an appended warning:

```
⚠️ RESULT contract violated (…) — read the full transcript before acting on this result.
```

and the journal row records a `result contract: …` note. Set `PI_RESULT_CONTRACT_GATE=0` to silence the appended warning (checks still run and are logged). Warm-up dispatches are exempt.

## ask_parent — Blocking Child Questions

When a sub-agent hits a decision only the captain can make (scope change, irreversible action, missing credentials), it calls:

```
ask_parent { question, options?, timeout_s? }
```

- The question lands as `<project>/.pi/agent-sessions/asks/<id>.json` with `status: "open"`.
- The tool **blocks** the child, polling every 2 s until answered or timed out.
- Timeout defaults to `PI_ASK_PARENT_TIMEOUT_S` (600 s); hard cap 1800 s regardless of what the caller asks for.
- On timeout the child is told to proceed autonomously with its stated reversible default and record the open question under `remaining:` in its `## RESULT`.

Parent side:

| Command | Effect |
|---|---|
| `/asks` | List known questions with id, agent, and status |
| `/ask-answer <id> <text>` | Answer a question; the blocked child wakes within ~2 s |

Question records keep their full history (`open` → `answered` / `expired` / `cancelled`) on disk, so answers survive restarts too. All four dispatch paths load the extension for children and pass agent identity via `PI_AGENT_NAME` / `PI_SESSION_FILE`.

## External Runtimes (toolkit workers)

Besides pi itself, named toolkit agents dispatch to external CLI runtimes. The first-class, usage-aware ones:

| Agent name | CLI invoked | Result text | Usage source |
|---|---|---|---|
| `omp-agent` | herdr: `omp` TUI (session jsonl); headless: `omp -p --mode json` | Assistant text (stream `message_end` or session jsonl) | Inline message usage |
| `prime-agent` | herdr: `prime-agent` TUI (session jsonl); headless: `-p --mode json --no-session` | Assistant text (same parser as omp) | Inline message usage |
| others (`cursor-agent`, `gemini-agent`, ...) | their plain CLIs | raw stdout tail (no structured parse) | not reported |

When herdr is enabled, external-CLI dispatches (`subagent_create` and TEAM `dispatch_agent`) open a **sibling split** of the caller's pane labeled with the harness (`omp-agent`, `prime-agent`, …). omp and prime run their interactive TUI there (not a JSON dump); completion is the `herdr-done` marker, and the parent reads the child's session jsonl. After the first turn the pane lingers labeled idle (12s on success, 30s on error/abort) then closes. `PI_HERDR_LINGER_MS=0` closes immediately; a positive value sets the success delay; `keep` leaves it open. Journal rows record `runtime` and the real `provider/model` from the stream; they do not invent a pi `sessionFile`. `/agents-status` marks such rows with a runtime tag:

```
DONE  tm07-k9a1 [omp]   12s 15,398tok (0% cached) $0.0035
```

(`[prime]` labels prime-agent rows; pi-runtime rows carry no tag.)

Notes:
- Both JSON-streaming runtimes report real token/cost usage into the journal row and the `/agents-status` TOTAL footer.
- They do not inherit the parent Pi home (`PI_CODING_AGENT_DIR` is not forwarded). omp uses `~/.omp/agent`, prime uses its own dir, each with that CLI's extensions and skills. Set `PI_TOOLKIT_BARE=1` to start them with extensions and skills off.
- They do not load agent-pi extensions, so RESULT-contract checking and `ask_parent` apply to pi-runtime sub-agents only. The parent still archives whatever they produced and records exit/elapsed.

## Tips

- After restarting a parent mid-run, check `/agents-status` first — reconciliation has usually already classified whatever the crash interrupted.
- To resume a specific sub-agent conversation, feed its `sessionFile` path to `pi -c <path>` semantics (the field exists exactly for that).
- Cost accounting reads each assistant message's `usage.cost.total`; runs without such messages simply show no cost segment.
