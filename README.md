<div align="center">

<img src="agent-logo.png" alt="agent-pi" width="240" />

<br />

<strong>Turn Pi into a practical multi-agent development workspace.</strong>

<br /><br />

[Install](#install) · [Quick start](#quick-start) · [Modes](#operational-modes) · [Orchestration](#multi-agent-orchestration) · [Configuration](#configuration)

</div>

---

## Overview

[Pi](https://github.com/badlogic/pi-mono) is a fast, terminal-first coding agent. **agent-pi** is an extension and configuration layer for Pi that adds structured workflows, specialist agents, browser-based review tools, security guardrails, themes, and reusable text utilities.

This repository is a maintained fork of [ruizrica/agent-pi](https://github.com/ruizrica/agent-pi). The fork keeps the upstream project's Pi-first architecture while evolving the package, prompts, agent definitions, and safety boundaries for this workspace.

The project is intentionally configuration-driven: extensions, Markdown agent definitions, YAML workflows, prompts, skills, and themes are loaded by Pi. There is no patched Pi runtime to maintain.

## Why agent-pi?

- **Six operating modes** — NORMAL, PLAN, SPEC, TEAM, CHAIN, and PIPELINE.
- **Multi-agent workflows** — delegate to specialists, run sequential chains, or execute phased pipelines.
- **Approval-aware execution** — task gates and plan approval keep higher-risk workflows explicit.
- **Security boundaries** — dangerous tool calls, prompt injection, SSRF, path traversal, and unsafe local viewers are checked at their boundaries.
- **Browser viewers** — review plans, specs, diffs, reports, and session artifacts in a local browser UI.
- **Research handoffs** — preserve source URLs, retrieval dates, uncertainty, conflicts, and failed lookups as structured context.
- **Customizable runtime** — add teams, chains, models, themes, commands, and skills without editing the Pi core.

## Requirements

- [Pi Coding Agent](https://github.com/badlogic/pi-mono)
- Node.js and npm
- Git
- [Bun](https://bun.sh/) for running the Bun-based test files

The bundled installer can install Pi when it is not already available. The Pi version used by the installer is pinned in `install.sh` for reproducible setup.

## Install

### Recommended: clone and run the installer

```bash
git clone https://github.com/voidflux01/agent-pi.git
cd agent-pi
./install.sh
```

The installer checks prerequisites, installs dependencies, and registers this checkout as a Pi package. Preview the actions without changing your system:

```bash
./install.sh --dry-run
```

### Install into an existing Pi setup

```bash
pi install git:github.com/voidflux01/agent-pi
```

Pi discovers the package's extensions, themes, skills, and prompts from `package.json`.

## Quick start

Start Pi and try a task:

```bash
pi
```

Useful controls and commands:

| Action | How |
| --- | --- |
| Run a normal task | Start typing in the default NORMAL mode |
| Switch workflow mode | Press `Shift+Tab` or use `set_mode` |
| Cycle terminal themes | Press `Ctrl+X` |
| Choose an agent team | `/agents-team` |
| Run or choose a chain | `/chain` |
| Open Text Tools | `/tex` |
| Run a project security sweep | `/secure` |
| Inspect persisted reports | `/reports` |

For a low-ceremony task, stay in NORMAL. Use PLAN, SPEC, TEAM, CHAIN, or PIPELINE when you need explicit planning, specialist delegation, or review gates.

## Operational modes

| Mode | Purpose |
| --- | --- |
| **NORMAL** | Standard Pi coding workflow. Existing task lists remain respected, but a new list is not required for every task. |
| **PLAN** | Analyze → create a plan → approve → implement → report. |
| **SPEC** | Turn an idea into requirements, tasks, and an implementation workflow. |
| **TEAM** | Delegate work to selected specialist agents through the primary agent. |
| **CHAIN** | Pass one agent's output into the next sequential step. |
| **PIPELINE** | Run a phased workflow such as UNDERSTAND → PLAN → BUILD → REVIEW, with parallel dispatch where configured. |

Higher-ceremony modes require an active task before write or execution tools are unlocked. PLAN also applies its plan-first approval workflow. The exact behavior is enforced by the extensions, not only described in prompts.

## Multi-agent orchestration

Agent definitions live in `agents/*.md`; teams and workflows live in YAML files under `agents/`.

### Teams

Teams are named groups of agents from `agents/teams.yaml`:

```yaml
plan-build:
  - planner
  - builder
  - reviewer
```

### Chains

Chains pass the previous step's output through `$INPUT`. `$ORIGINAL` refers to the user's original request:

```yaml
plan-build-review:
  description: "Plan, implement, and review"
  steps:
    - agent: planner
      prompt: "Plan the implementation for: $INPUT"
    - agent: builder
      prompt: "Implement this plan:\n\n$INPUT"
    - agent: reviewer
      prompt: "Review this implementation:\n\n$INPUT"
```

### Pipelines

Pipelines in `agents/pipeline-team.yaml` model longer workflows as named phases. They can combine interactive checkpoints, specialist roles, parallel dispatch, and review loops.

The repository includes workflows for common tasks such as `plan-build`, `plan-build-review`, `research-plan-build-review`, `investigate-fix`, `test-fix`, and `audit`.

### Research handoffs

When a task needs current external facts, the researcher agent uses the web capabilities available at runtime. It returns source-backed facts, URLs, retrieval dates, uncertainty, conflicts, and failed lookups. The orchestration layer can persist that report before passing it to local exploration, planning, or implementation agents.

If no compatible web capability is available, the workflow continues with repository evidence and clearly marks external facts as unverified.

## Safety model

agent-pi applies safety checks at multiple boundaries:

1. **Tool-call gate** — checks dangerous commands and sensitive operations before execution.
2. **Context guard** — scans tool results for prompt-injection content before it becomes agent context.
3. **Task and approval gates** — require explicit task progress and plan approval in the workflows that need them.
4. **Viewer boundaries** — local browser viewers use capability authentication, origin checks, escaping, and bounded file access.
5. **Child-runtime boundaries** — delegated workers receive a restricted environment and cannot spawn from unrelated lifecycle callbacks.

Use `/secure` to run the security workflow against a project and optionally install portable protections. Treat guardrails as defense in depth: review commands, diffs, permissions, and external integrations before approving them.

## Package layout

```text
├── agents/       Agent definitions, teams, chains, pipelines, and model routing
├── commands/     Slash-command definitions
├── extensions/   Pi extensions and shared runtime libraries
├── prompts/      Reusable prompt templates
├── skills/       Pi skill packs
├── themes/       Custom terminal themes
├── tex/          Standalone Text Tools app
├── docs/         Design notes, validation logs, and screenshots
├── install.sh    Installer and Pi package registration helper
└── package.json  Pi package manifest and test scripts
```

## Text Tools

`tex/` is a zero-backend, single-page text utility. Open it with `/tex` or directly with `tex/index.html`.

- Stackable operations for trimming, deduplication, sorting, case conversion, and regex replacement
- Before/after diff view
- Works offline with no build step
- Dark UI matching the terminal workflow

## Configuration

### Model routing

Model assignments are resolved from the first matching file:

1. `<project>/.pi/agents/models.json`
2. `~/.pi/agents/models.json` or `~/.pi/agent/agents/models.json`
3. `agents/models.json` bundled with this package

Use a project- or user-level file to map agents to the providers and models available in your environment. `toolkit-models.json` follows the same resolution order.

### Herdr integration

When running inside [Herdr](https://github.com/ruizrica/herdr), delegated workers can open in watchable sibling panes. Install Herdr's Pi integration when needed:

```bash
herdr integration install pi
```

Useful environment switches:

```bash
PI_HERDR_SUBAGENTS=0  # disable visible Herdr workers
PI_HERDR_SPLIT=0      # use background tabs instead of sibling splits
```

### Commander MCP (optional)

Commander integration is disabled by default. Enable it by pointing to a Commander MCP server build:

```bash
export COMMANDER_MCP_SERVER_PATH="/path/to/commander/services/commander-mcp/dist/server.js"
```

When unset, Commander tools report that they are not configured instead of spawning a server.

## Development

Install dependencies and run the test suite. Bun is required because part of the
suite uses `bun:test`; the remaining tests run through Vitest:

```bash
npm ci
(cd extensions && npm ci)
npm test
```

Run the full local check, including the production dependency audit:

```bash
npm run check
```

Before a release or public push, run the stricter end-to-end local check:

```bash
npm run verify:release
```

Check package paths, runtime imports, YAML files, dependencies, and local Pi
registration:

```bash
npm run doctor
npm run doctor:strict   # treat warnings as failures
npm run verify:package  # pack and install in a disposable clean directory
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [CHANGELOG.md](CHANGELOG.md) for project history.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Extensions are not loading | Reinstall with `pi install git:github.com/voidflux01/agent-pi`, then inspect `pi config`. |
| Themes are missing | Confirm the package is registered and the `themes/` directory is present. |
| `Shift+Tab` does nothing | Confirm `mode-cycler` is loaded. |
| Chains or pipelines are missing | Confirm the package's `agents/` directory is available to the extensions. |
| Agents use an unexpected model | Add a project- or user-level `models.json` override. |
| Commander tools say “not configured” | Set `COMMANDER_MCP_SERVER_PATH` to a valid server build. |

## Credits

Built on [Pi Coding Agent](https://github.com/badlogic/pi-mono) by Mario Zechner ([@badlogic](https://github.com/badlogic)).

Forked from [ruizrica/agent-pi](https://github.com/ruizrica/agent-pi). The original project was inspired in part by [IndyDevDan's Pi video](https://youtu.be/f8cfH5XX-XU).

## License

[MIT](LICENSE)
