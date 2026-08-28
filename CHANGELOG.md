# Changelog

All notable changes to agent-pi will be documented in this file.

## Unreleased

### Herdr sibling splits for sub-agents

When the parent is already inside Herdr, `subagent_create` / team / chain /
pipeline workers open as a **sibling split of the caller's pane** (wide →
right, tall → down, `--no-focus`) so you can watch the child TUI on the same
screen. Finished workers close only that pane — never the parent's tab.
Falls back to a background tab if split is unavailable, and to headless if
Herdr is absent. Opt out of splits with `PI_HERDR_SPLIT=0`.

### Plan viewer empty tab

`show_plan` used to 302 from `/?token=…` to `/` after Set-Cookie. Chrome often
follows the redirect before the cookie is stored, so the tab lands on a blank
401 page. The token URL now serves the page on the first request. The TUI now
prints that same launch link for every token-auth viewer (plan, spec,
file, board, reports, research, sounds, cleanup, security, completion),
not only `show_plan`. `web-chat` is PIN-gated and unchanged.

A second empty-body bug: plan / spec / completion HTML inlined
`/^(https?:|mailto:|tel:|#|\/)/` inside a template string, so the browser
saw an unterminated regex and never ran `render()`. `#renderedView` stayed
blank even on a 200 token URL. Those sanitizers now use `new RegExp(...)`.

### Subagent pane titles show the role

Herdr sibling panes were titled `π - security-guard` because the child's first
`-e` flag is security-guard. Workers now pass `PI_PANE_TITLE` / `herdrLabel`
like `scout-sa1`. Opt out of first-turn tool pinning with
`PI_PIN_ORCHESTRATION_TOOLS=0`.

### Scout RESULT is the report

Parent-visible sub-agent results still archive the full transcript, but a
usable `## RESULT` no longer says `Use the read tool on that path`. The
parent is told not to read the file unless RESULT is missing a path or
quote. Missing or broken RESULT still points at the archive.

### Subagent elapsed as `Nm Ns`

Completion lines (`composeAgentResult` header and the TUI
`SAn (role) done in …` notify) use `formatDuration`: under a minute stays
`53s`, a minute or more is `1m 12s`. Negative input clamps to `0s`; hours
are not a unit.

### Walk-through usage fixes

- `grill_record_turn` / `grill_save_results` / `/grill-me` used a missing
  `ctx` (the execute argument is `ctx2`) and threw `ctx is not defined`.
- `show_plan` no longer auto-arms grill-me; pass `grill: true` to opt in.
  When grill is armed and unfinished, the approval follow-up says not to
  implement yet.
- `set_mode` no longer aborts the current turn or injects
  `Continue the task in PLAN mode.` The next provider request in the same
  run gets the new mode system prompt. PLAN's scout rule is one line:
  scout unless you already know the single file to change.
- Viewer open is also a display message plus a status line with the token URL.
- `tasks` tool text states that only one task can be inprogress at a time.
- `show_plan` / `show_spec` no longer send a `plan-approved` / `spec-approved`
  follow-up after the tool result. The current turn continues from the
  result; a queued follow-up used to pop `[plan-approved]` after
  implementation finished. `/plan` and `/spec` still inject a follow-up
  because they have no tool result.

### Toolkit / multi-harness runtimes

- `subagent_create` for `omp-agent` / `prime-agent` (and other toolkit CLIs)
  uses a Herdr **sibling split** of the caller pane (same as scout / TEAM),
  labeled `omp-agent` / `prime-agent` via pane rename + `report-agent` /
  `report-metadata` so the chip is not `bash`. Falls back to a labeled tab,
  then headless. omp / prime in that pane run their **interactive TUI** (no
  `-p --mode json`, no `tee`), same idea as pi's visible transport. Headless
  fallback still prints JSON. Finished splits linger labeled idle (12s on
  success, 30s on error/abort) then close so a short PONG is visible without
  stacking panes. `PI_HERDR_LINGER_MS=0` closes immediately; a positive value
  sets the success delay; `keep` leaves the pane open.
- Toolkit `subagent_create` blocks until the CLI exits, same as scout, so the
  parent does not poll with `subagent_list` / `sleep`.
- Child Pi / omp / prime dispatches no longer pass `--thinking off`; thinking
  follows the harness default or the model the parent already selected.

### Chain / team / pipeline walk-through

- Chain (and team/pipeline) step lines use the RESULT `summary:` instead of
  the last transcript line (`## END`).
- Switching mode hides the previous workflow widget (chain timeline no longer
  sits on TEAM/PIPELINE).
- Successful Pi herdr child panes linger 12s then close; error/abort linger
  30s (`PI_HERDR_LINGER_MS=keep` to leave them open).
- `advance_phase` refuses to leave PLAN/BUILD/GATHER/EXECUTE/REVIEW until
  `dispatch_agents` has run in that phase. UNDERSTAND may still advance
  without dispatch.
- `/pipeline` labels show the full phase flow (`plan-build (plan → build)`)
  and switching to a pipeline also sets mode PIPELINE.
- Default TEAM is `plan-build` when present, not `all` (22).
- `show_plan` questions mode accepts `submitted` as well as `approved`, so
  Submit Answers is not reported as "closed without submitting".
- `/mode` away from CHAIN/TEAM/PIPELINE passes the live UI ctx so the chain
  timeline (and other workflow widgets) actually hide; previously the CHAIN
  color bar cleared but `── plan-build-review ──` stayed above the editor.
- Chain coordinator prompt no longer invites mixing bash/python with
  `run_chain`; after the chain returns, quote RESULT only.
- TEAM / scout cards poll the child session jsonl while running so Tools
  is not stuck at 0 until exit.
- A new herdr worker closes lingered siblings first, then always sibling-splits
  the caller pane (`PI_HERDR_SPLIT=0` still opts out). Tab-create is only the
  fallback when split is unavailable.
- Orchestration prompts tell the parent to treat ## RESULT as the report and
  not re-run child verification. Herdr TUI tool counts are read from the
  session file when the JSON stream is absent.
- Built-in toolkit agent defs so TEAM lists `omp-agent` and `prime-agent`
  without `.pi/agents/toolkit/*.md`.
- Journal records the stream's real `provider/model`, not the dummy Haiku
  worker model, and omits a pi `sessionFile` that those CLIs never write.
- External runtimes skip the `## RESULT` contract warning; parent-visible
  output is the CLI text.
- Background subagent results inject as `steer` after the current tool
  batch, so a parent that keeps polling no longer blocks the result turn.
- Child env no longer forwards `PI_CODING_AGENT_DIR` / `PI_PACKAGE_DIR`,
  so omp / prime use their own homes instead of the parent `~/.pi/agent`.
  Their extensions and skills stay on; set `PI_TOOLKIT_BARE=1` to pass
  `--no-extensions --no-skills` (prime: `-ne -ns`). Journal run ids
  include a unique suffix; updates patch the last matching row. Herdr
  toolkit panes set an OSC title from the role name.

### Flash first-turn still has PLAN/scout tools

`pi-deepseek-route` narrows Flash to read/write/edit/bash on turn 1, which hid
`set_mode`, `tasks`, `subagent_create`, and `show_plan`. agent-pi now pins those
back onto the active surface for the first turn, then restores the full set.

## [2.2.0] — 2026-08-27

### Deterministic RESULT-Contract Gate

Every finished sub-agent transcript is now mechanically checked against the
## RESULT contract — zero tokens, pure text mechanics. A compliant result
stays completely silent; a broken one announces itself in three places.

- **`checkResultCompliance()`** — requires a `## RESULT` block with `done:` /
  `summary:` lines and an exact `## END` closer (tiber-inspired delivery check)
- **`/agents-status` + parent results** — team/chain/pipeline tool results get
  a visible `⚠️ RESULT contract violated (...)` warning line when broken;
  `composeAgentResult` also returns `contractProblems[]` for programmatic use
- **SA widget integration** — subagent runs record violations as journal-row
  notes and append the warning to the parent follow-up message
- Warmup/spawn-exempt; opt-out via `PI_RESULT_CONTRACT_GATE=0` (problems are
  still computed and journaled, only the warning lines disappear)
- 9 unit tests (`result-contract-check.test.ts`) pass standalone and in-suite

### SA Runs Join the Durable Task Journal

`subagent_create` / `/subcont` dispatches are no longer invisible to
`/agents-status`.

- Every spawn appends a `kind:"sa"` row whose id equals its archived
  transcript base name (`<agent>-sa<id>-<turn>`)
- Completion closes the row with status / exitCode / elapsedMs / outputFile —
  the same lifecycle team/chain/pipeline rows already had
- Restart reconciliation and 7-day retention cover SA rows automatically

### Workspace Provenance Ledger (anti-hijack)

Fixed: herdr workspace reuse could grab the user's own same-label workspace.
Reuse is now provenance-based:

- Workspaces created by agent-pi are recorded in
  `.pi/agent-sessions/herdr-workspaces.json`
- Only ledgered ids still present in `herdr workspace list` are reused;
  anything else falls through to fresh create-and-record
- Verified live: create → reuse → externally-closed id replaced by new one

### Delegation Guard + Captain Etiquette

- **delegation-guard** extension blocks model-initiated headless `pi -p …` /
  `pi --mode json …` bash calls that would bypass dispatch tools (no journal,
  no herdr tab, no RESULT contract). Interactive pi panes stay allowed.
  Opt-out: `PI_DELEGATION_GUARD=0`. Detection is a pure token probe with unit
  tests (`pip`, path prefixes, quotes, `pi.exe` handled)
- **Outcome etiquette**: `dispatch_agent` / pipeline `dispatch_agents`
  descriptions now instruct the parent to lead with results and next
  decisions — not internal mechanics (tabs, polling, journal ids, transport)

### Restart Reconciliation for the Task Journal

Orphaned rows from crashes/hard kills self-heal at session start and before
dispatch:

- Rows whose persisted output or last assistant message contains the RESULT
  marker flip to `done`; PIDs still alive are skipped; quiet sessions inside a
  grace window are skipped; everything else becomes `error` with an audit note
- Never fabricates status from thin air — flips require on-disk evidence

### Herdr Transport for All Four Dispatch Paths

Team dispatch, chains, pipelines, and subagent widgets can now run their
sub-agents as visible herdr panes instead of headless child processes:
observable, attachable mid-run, persistent across parent restarts. Falls back
to headless when herdr is absent — precision never depends on it. Includes
per-run environment hardening and full-transcript archiving for SA runs.

### 7-Day Rolling Retention

`outputs/*.txt` archives and journal rows older than 7 days are pruned at
dispatch/session-start (mtime-based), with corrupt journal lines preserved
verbatim. Removes session-dir bloat without touching anything recent.

### Per-Run Token & Cost Accounting

Every dispatch path now records what it cost:

- `sessionUsage()` sums tokens + cost across all assistant messages in the
  run's pi session file (cache-aware, corruption-tolerant)
- Journal rows gain a `usage` block (input / output / cacheRead /
  cacheWrite / totalTokens / costUsd)
- `/agents-status` renders per-row `<tokens> (<pct>% cached) $<cost>` plus a
  TOTAL footer over the recent window
- Zero-usage rows render exactly as before

### Docs & Policy Accuracy

- CLAUDE.md remotes section rewritten to match reality (single public origin)
- New unit-test suites: delegation-guard, journal-prune, journal-reconcile,
  result-contract-check

## [2.1.0] — 2026-03-25

### Web Chat — Remote Access from Any Device

New extension that lets you interact with your Pi session from your phone, tablet, or any device. Messages are relayed directly into the running session — same conversation, same tools, same subagents.

- **`/chat`** — Opens a LAN-accessible chat UI with 6-digit PIN authentication
- **`/chat --remote`** — Secure Cloudflare Quick Tunnel for access from anywhere (no account needed)
- **`/chat stop`** — Shuts down the server and tunnel
- **WebSocket streaming** — Real-time token delivery, tool call notifications, subagent visibility
- **Mobile-first UI** — Dark blue theme, markdown rendering, slash command menu, terminal activity tab
- **Security** — PIN auth, single-user lock, token-based sessions, auto-shutdown after 2 min idle
- **QR code display** — Scan from terminal to connect instantly from your phone
- See [docs/web-chat.md](docs/web-chat.md) for full documentation

### Subagent Lifecycle Management

Fixed a critical issue where subagents (especially scouts in PLAN mode) could run indefinitely, stacking zombie widgets that never cleaned up.

- **Watchdog timeouts** — Role-based kill timers: scout=10min, builder=30min, reviewer=15min, default=20min
- **`subagent_cleanup` tool** — Explicitly remove done/error/stale agents with configurable max age
- **Auto-cleanup before batch spawns** — `subagent_create_batch` removes leftover agents before spawning new ones
- **Duplicate batch guard** — Blocks spawning a new batch while agents are still running (override with `force: true`)
- **Timeout warnings in widget** — Shows "Xs left" at 80% of max duration, "TIMING OUT" at 95%
- **PLAN prompt lifecycle guidance** — Teaches agents about scout timeouts, auto-dismiss, and cleanup rules

### QA Automation Skill

New skill package for generic QA testing with agent-device and agent-browser integration.

- **qa-test-flows** — CDP-based test flow execution with helpers
- **qa-web** — Web testing with browser automation helpers
- **qa-scroll** — Scroll testing with gesture simulation
- **qa-state-persistence** — State management testing across app sessions
- **qa-device-management** — Device coordinate mapping and management
- **qa-setup** — Environment setup and configuration

### Task Board Improvements

- Local-first board viewer — always shows local tasks even when Commander is offline
- Full-height columns, removed max-width cap
- Polished task cards with colored borders, shadows, and status tints
- Removed emoji icons from empty states

### Bug Fixes

- **web-chat:** Fixed message echo (user messages being relayed back as assistant messages)
- **web-chat:** Fixed SSE flush through cloudflared tunnels (migrated to WebSocket)
- **web-chat:** Fixed stuck thinking indicator — restored done signal in message_end
- **web-chat:** Fixed terminal tab layout (was display:block in a flex parent)
- **web-chat:** Cleaned QR code display — no distortion, proper padding

## [2.0.0] — 2026-03-20

### ⚡ Restructured as Pi Package

**Breaking change:** The entire repo has been restructured from a nested `agent/` layout to a flat Pi package. Install with one command:

```bash
pi install git:github.com/ruizrica/agent-pi
```

- **Flat layout** — `extensions/`, `themes/`, `skills/`, `agents/` at repo root
- **Pi package manifest** — `package.json` with `pi` key for auto-discovery
- **No more manual setup** — no installer scripts, no symlinks, no manual config
- **Agent path resolution** — extensions now check both `.pi/agents/` and `agents/` for backward compatibility
- Removed: `install.sh`, `pi-doctor.sh`, `agent/` nesting, `docs/`, `disk-cleanup/`, `context-os/`

## [1.0.0] — 2025-03-11

### 🎉 Initial Public Release

The first public release of agent — a comprehensive extension suite that transforms [Pi Coding Agent](https://github.com/badlogic/pi-mono) into a multi-agent orchestration platform.

### Extensions (28 total)

#### Core UI
- **agent-banner** — ASCII art startup banner with theme-aware coloring
- **footer** — Status bar with model name, context percentage, and working directory
- **agent-nav** — F-key navigation shared across agent widgets (chain, team, pipeline)

#### Task Management
- **tasks** — Task discipline system gating tools until tasks are defined; three-state lifecycle (idle → inprogress → done) with live widget
- **commander-mcp** — Bridge exposing Commander MCP tools as native Pi tools
- **commander-tracker** — Reconciles local tasks with Commander and retries failed sync

#### Operational Modes
- **mode-cycler** — Cycles through NORMAL / PLAN / SPEC / PIPELINE / TEAM / CHAIN modes via Shift+Tab

#### Multi-Agent Orchestration
- **agent-team** — Dispatcher-only orchestrator with specialist agents and grid dashboard
- **agent-chain** — Sequential pipeline orchestrator chaining agent steps with prompt templates
- **pipeline-team** — Hybrid sequential + parallel pipeline (UNDERSTAND → GATHER → PLAN → EXECUTE → REVIEW)
- **subagent-widget** — Background subagent process management with live status widgets
- **toolkit-commands** — Dynamic slash commands from `.pi/commands/` markdown files

#### Security
- **security-guard** — Pre-tool-hook defense system blocking destructive commands, detecting prompt injection, preventing exfiltration
- **secure** — `/secure` command for AI security sweeps and protection installation
- **message-integrity-guard** — Prevents session-bricking from orphaned tool_result messages

#### Viewers & Reports
- **plan-viewer** — Interactive browser GUI for markdown plan review (approve/edit/reorder) and question answering
- **completion-report** — Browser GUI showing work summary, file diffs, and per-file rollback
- **spec-viewer** — Multi-page browser GUI for spec review with inline comments and visual gallery
- **file-viewer** — Lightweight local file viewer/editor in the browser
- **reports-viewer** — Searchable `/reports` browser view for persisted plans, specs, and reports

#### Developer Tools
- **debug-capture** — VHS-based terminal screenshot tool for visual TUI debugging
- **web-test** — Cloudflare Browser Rendering for screenshots, content extraction, and accessibility audits
- **tool-registry** — In-memory index of all available tools with categorization and search
- **tool-search** — Meta-tool for discovering and inspecting available tools at runtime
- **tool-caller** — Meta-tool for invoking tools programmatically by name (dynamic composition)
- **lean-tools** — Reduces system prompt bloat by deactivating non-essential tools

#### Session & Context
- **memory-cycle** — Memory-aware compaction saving/restoring context across compaction cycles
- **session-replay** — Scrollable timeline replay of conversation history via `/replay`
- **escape-cancel** — Double-ESC cancels all running operations (agent, subagents, chains, pipelines)
- **system-select** — Switch system prompts by selecting agent definitions via `/system`

### Agent Definitions
- **scout** — Read-only codebase exploration and recon
- **planner** — Implementation planning and architecture
- **builder** — Code implementation following existing patterns
- **reviewer** — Code review for bugs, style, and correctness
- **tester** — Test writing and execution
- **red-team** — Security vulnerability analysis

### Teams & Pipelines
- 8 pre-configured teams (all, toolkit, full, plan-build, investigate, quality, refactor, docs)
- 9 chain workflows (plan-build-review, audit, secure, performance, sentry-setup, and more)
- 2 pipeline configurations (plan-build-review, plan-build)

### Themes
- 11 custom themes: Catppuccin Mocha, Cyberpunk, Dracula, Everforest, Gruvbox, Midnight Ocean, Nord, Ocean Breeze, Rose Pine, Synthwave, Tokyo Night

### Skills
- agent-browser — Browser testing skill pack
- nano-banana — Image generation skill
- just-bash — Shell-only skill


### Model Providers
- Mercury (4 models)
- Synthetic (16 models including GLM, Qwen, Kimi, MiniMax)
- OpenRouter (9 models)
- MiniMax Coding (1 model)
