<div align="center">

<img src="agent-logo.png" alt="agent" width="240" />

<br/>

**An extension suite that turns [Pi](https://github.com/badlogic/pi-mono) into a multi-agent orchestration platform**

[Install](#install) · [Extensions](#extensions) · [Modes](#operational-modes) · [Orchestration](#multi-agent-orchestration)

</div>

---

## What is this?

[Pi](https://github.com/badlogic/pi-mono) is a terminal-based AI coding agent by [@badlogic](https://github.com/badlogic). Out of the box it's a single-agent assistant with tool use, conversation memory, and a TUI.

**agent** is a Pi package — **48 extensions, 11 themes, and 20+ skills** that transform Pi into something more:

- **6 operational modes** — NORMAL, PLAN, SPEC, PIPELINE, TEAM, CHAIN
- **Multi-agent orchestration** — dispatch teams, run sequential chains, or execute parallel pipelines
- **Security hardened** — pre-tool-hook guard blocks destructive commands, detects prompt injection, prevents data exfiltration
- **Browser-based viewers** — interactive plan review, completion reports with rollback, spec approval with inline comments
- **11 themes** — Catppuccin, Dracula, Nord, Synthwave, Tokyo Night, and more

Everything is configuration — no forks, no patches. Just extensions, agent definitions, and YAML.

## Install

### One-line installer (recommended)

Don't have Pi installed? No problem. The installer handles everything — installs Pi, registers the package, and configures settings in one go:

```bash
git clone https://github.com/voidflux01/agent-pi.git && cd agent-pi && ./install.sh
```

### Already have Pi?

```bash
pi install git:github.com/voidflux01/agent-pi
```

Pi discovers all extensions, themes, and skills automatically.

### First Steps

1. **Type a task** — NORMAL is the default low-ceremony mode. Simple work starts directly; clear multi-step work may use a local task list without entering PLAN.
2. **Shift+Tab** or **`set_mode`** — Opt into PLAN / SPEC / PIPELINE / TEAM / CHAIN when the task needs that workflow or approval.
3. **Ctrl+X** — Cycle themes
4. **`/agents-team`** — Switch between agent teams
5. **`/chain`** — Switch between chain workflows
6. **`/tex`** — Open Text Tools in the browser

## Package Structure

```
├── package.json         Pi package manifest
├── extensions/          43 TypeScript extensions + lib/
├── themes/              11 custom terminal themes
├── skills/              20+ skill packs
├── agents/              Agent definitions + chain/pipeline/team YAML
├── commands/            Toolkit slash commands
├── prompts/             Prompt templates
└── tex/                 Text Tools — standalone text manipulation app
```

## Optional developer tools

Set `PI_OPTIONAL_ADAPTERS=1` to enable the bundled LSP client and MCP adapter. They are loaded lazily and failure-safe; the core extension suite remains usable when either dependency or its server is unavailable. `fff_find` and `fff_grep` use the native FFF engine when available and fall back to the platform search tools. Worktree isolation is opt-in: set `PI_PIPELINE_WORKTREES=1` for PIPELINE builders or `PI_TEAM_WORKTREES=1` for TEAM builders; worker diffs are merged back only after the worker exits successfully, and failed worktrees are retained for inspection.

## Extensions

### Core UI

| Extension | Description |
|-----------|-------------|
| **agent-banner** | ASCII art banner on startup, auto-hides on first input |
| **footer** | Status bar — model name, context %, working directory |
| **agent-nav** | F1-F4 navigation shared across agent widgets |
| **theme-cycler** | Ctrl+X to cycle through installed themes |
| **escape-cancel** | Double-ESC cancels all running operations |

### Task Management

| Extension | Description |
|-----------|-------------|
| **tasks** | Task tracking — optional in NORMAL; required and gated in PLAN / SPEC / PIPELINE / TEAM / CHAIN; idle → inprogress → done lifecycle |
| **commander-mcp** | Bridge exposing Commander dashboard tools as native Pi tools |
| **commander-tracker** | Reconciles local tasks with Commander; retries failed sync |

### Operational Modes

| Extension | Description |
|-----------|-------------|
| **mode-cycler** | Shift+Tab cycles NORMAL / PLAN / SPEC / PIPELINE / TEAM / CHAIN |

Each mode injects a tailored system prompt. NORMAL does not require a task list, but an existing list is strict unless `PI_TASKS_STRICT=0`. PLAN / SPEC / TEAM / CHAIN / PIPELINE require an active task before write or execution tools. PLAN also enforces its plan-first approval workflow.

**Dispatch safety:** Child Pi processes and Herdr tabs start only from a tool `execute` or slash-command handler. Session start/switch/shutdown cannot spawn, even if they open a dispatch context. Timer callbacks cannot inherit spawn rights. Toolkit workers and Herdr tab creation use the same gate.

### Multi-Agent Orchestration

| Extension | Description |
|-----------|-------------|
| **agent-team** | Dispatch-only orchestrator — primary agent delegates to specialists via `dispatch_agent` |
| **agent-chain** | Sequential pipeline — each step's output feeds into the next via `$INPUT` |
| **pipeline-team** | 5-phase hybrid — UNDERSTAND → GATHER → PLAN → EXECUTE → REVIEW |
| **subagent-widget** | Background subagent management with live status widgets |
| **toolkit-commands** | Dynamic slash commands from markdown files |

### Security

| Extension | Description |
|-----------|-------------|
| **security-guard** | Pre-tool-hook: blocks `rm -rf`, `sudo`, credential theft, prompt injection |
| **secure** | `/secure` — full AI security sweep + protection installer for any project |
| **message-integrity-guard** | Prevents session-bricking from orphaned tool_result messages |

### Viewers & Reports

| Extension | Description |
|-----------|-------------|
| **plan-viewer** | Browser GUI — plan approval with checkboxes, reordering, inline editing |
| **completion-report** | Browser GUI — work summary, unified diffs, per-file rollback |
| **spec-viewer** | Browser GUI — multi-page spec review with comments and visual gallery |
| **file-viewer** | Browser GUI — syntax-highlighted file viewer with optional editing |
| **reports-viewer** | Searchable `/reports` browser view for all persisted artifacts |

<div align="center">
<img src="docs/screenshots/plan-viewer.png" alt="Plan Viewer — structured plan approval with phases, context, and file action badges" width="720" />
<br/><em>Plan Viewer — structured plan with approval controls, phase blocks, and inline code references</em>
</div>

<div align="center">
<img src="docs/screenshots/completion-report.png" alt="Completion Report — file change stats, summary, and unified diffs with rollback" width="720" />
<br/><em>Completion Report — file change stats, work summary, and per-file rollback</em>
</div>

### Developer Tools

| Extension | Description |
|-----------|-------------|
| **debug-capture** | VHS-based terminal screenshots for visual TUI debugging |
| **web-test** | Cloudflare Browser Rendering — screenshots, content extraction, a11y audits |
| **tool-registry** | In-memory index of all tools with categories and search |
| **tool-search** | Meta-tool — discover and inspect tools at runtime |
| **tool-caller** | Meta-tool — invoke any tool programmatically (dynamic composition) |
| **lean-tools** | Toggle lean mode — agent uses `tool_search` + `call_tool` instead of all tools |

### Session & Context

| Extension | Description |
|-----------|-------------|
| **memory-cycle** | Memory-aware compaction — saves/restores context across compaction |
| **session-replay** | `/replay` — scrollable timeline of conversation history |
| **system-select** | `/system` — switch system prompt by picking agent definitions |

## Operational Modes

| Mode | Trigger | Behavior |
|------|---------|----------|
| **NORMAL** | Default | Standard coding assistant |
| **PLAN** | Shift+Tab | Plan-first workflow — analyze → plan → approve → implement → report |
| **SPEC** | Shift+Tab | Spec-driven — shape → requirements → tasks → implement |
| **TEAM** | Shift+Tab | Dispatcher mode — primary delegates, specialists execute |
| **CHAIN** | Shift+Tab | Sequential pipeline — step outputs chain into next step |
| **PIPELINE** | Shift+Tab | 5-phase hybrid with parallel dispatch |

## Multi-Agent Orchestration

### Teams

Teams are defined in `agents/teams.yaml`. Each team is a list of agent names. Agent definitions live in `agents/*.md` with YAML frontmatter.

```yaml
plan-build:
  - planner
  - builder
  - reviewer
```

### Chains

Chains are sequential pipelines defined in `agents/agent-chain.yaml`. Each step specifies an agent and a prompt template with `$INPUT` (previous output) and `$ORIGINAL` (user's original prompt).

```yaml
plan-build-review:
  description: "Plan, implement, and review"
  steps:
    - agent: planner
      prompt: "Plan the implementation for: $INPUT"
    - agent: builder
      prompt: "Implement the following plan:\n\n$INPUT"
    - agent: reviewer
      prompt: "Review this implementation:\n\n$INPUT"
```

### Pipelines

Pipelines are defined in `agents/pipeline-team.yaml` and combine sequential phases with parallel agent dispatch.

## Security

The security system operates at three layers:

1. **`tool_call` hook** — Pre-execution gate blocks dangerous commands before they run
2. **`context` hook** — Content scanner strips prompt injections from tool results
3. **`before_agent_start` hook** — System prompt hardening reminds the agent of security rules

The `/secure` command runs a comprehensive AI security sweep on any project and can install portable protections.

## Themes

11 themes included. Cycle with **Ctrl+X**:

Catppuccin Mocha · Cyberpunk · Dracula · Everforest · Gruvbox · Midnight Ocean · Nord · Ocean Breeze · Rose Pine · Synthwave · Tokyo Night

## Text Tools

A lightweight, zero-dependency text manipulation app bundled in `tex/`. Open it with `/tex` or directly at `tex/index.html`.

- **15 stackable operations** — trim, dedupe, sort, case transforms, regex replace, and more
- **Before/after diff view** — see exactly what changed
- **No backend, no build step** — single HTML page, works offline
- **Dark theme** — matches the terminal aesthetic

## Configuration

### Model persistence

Model changes are session-scoped by default. Use `/model-save` after selecting a model to make the current provider/model the default for future Pi sessions. This explicit step prevents temporary Herdr worker fallbacks from changing the global default.

Pi startup is configured with `quietStartup` and `collapseChangelog` so worker panes show task output instead of startup inventory and update noise. Errors, tool calls, and final results remain visible.

### Model routing (`models.json`)

Agent-to-model assignments are resolved from the first matching file, in this order:

1. `<project>/.pi/agents/models.json` — per-project override
2. `~/.pi/agents/models.json` or `~/.pi/agent/agents/models.json` — user-level override
3. `agents/models.json` in this package — bundled defaults

The bundled defaults reference models across several providers. Chain execution is
consent-preserving: ordinary bundled chain roles inherit the provider/model that
launched the Pi session. A project/user `models.json` entry or an agent's explicit
`model:` frontmatter may intentionally route a chain step elsewhere.
`toolkit-models.json` follows the same file resolution order.

### Commander MCP (optional)

The `commander-mcp` bridge is optional and off by default. To enable it, point
`COMMANDER_MCP_SERVER_PATH` at your commander-mcp build:

```bash
export COMMANDER_MCP_SERVER_PATH="/path/to/commander/services/commander-mcp/dist/server.js"
```

When unset, Commander tools report "not configured" instead of trying to spawn a server.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Extensions not loading | `pi install git:github.com/voidflux01/agent-pi` — reinstall the package |
| No themes available | Same as above — themes are auto-discovered from the package |
| Shift+Tab not working | Ensure mode-cycler extension loaded — check `pi config` |
| No chains/pipelines | Agent configs at `agents/` are loaded automatically by extensions |
| Agents use unexpected models | Add a user-level `models.json` — see [Configuration](#configuration) |

## Built on Pi

This project is a configuration and extension layer for [Pi Coding Agent](https://github.com/badlogic/pi-mono) by Mario Zechner ([@badlogic](https://github.com/badlogic)). Pi provides the core runtime, TUI framework, LLM integration, and extension API.

---

By [Ricardo Ruiz](https://ruizrica.io)

Inspired by the work of [IndyDevDan](https://www.youtube.com/@indydevdan) — check out his [excellent video on Pi](https://youtu.be/f8cfH5XX-XU?si=RcZoSAKeASaU-lPM) that helped shape this project.

## License

[MIT](LICENSE)
