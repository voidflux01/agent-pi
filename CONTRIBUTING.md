# Contributing to agent

Thank you for your interest in contributing to agent! This guide will help you get started.

## Getting Started

1. **Fork the repository** and clone your fork
2. **Install Pi** — follow the [Pi Coding Agent](https://github.com/badlogic/pi-mono) installation instructions
3. **Install dependencies** — `npm install` in the root directory and install [Bun](https://bun.sh/) for the full test suite
4. **Run Pi with extensions** — `pi` from the project root (settings.json auto-loads extensions)

## Project Structure

```
extensions/          # All custom extensions (TypeScript)
  lib/               # Shared library code for extensions
  __tests__/         # Test suite
  web-test-worker/   # Cloudflare Worker for browser testing
  assets/            # Static assets (logos, etc.)
agents/              # Agent definitions and team configs
commands/            # Toolkit slash commands
prompts/             # Prompt templates
themes/              # Custom terminal themes (.json)
skills/              # Skill packs
package.json         # Pi package manifest
```

## Writing Extensions

Extensions are TypeScript files that export a default function receiving the Pi `ExtensionAPI`:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Register tools, commands, shortcuts, widgets, and hooks
  pi.registerTool({ name: "my_tool", /* ... */ });
  pi.registerCommand("my-cmd", { /* ... */ });
  pi.registerShortcut("ctrl+k", { /* ... */ });
}
```

See [docs/EXTENSIONS.md](docs/EXTENSIONS.md) for the full extension reference.

## Guidelines

### Code Style

- **TypeScript** — all extensions are written in TypeScript
- **ABOUTME comments** — every extension file starts with two `// ABOUTME:` lines describing its purpose
- **JSDoc** — use doc comments for exported functions and key types
- **Minimal dependencies** — prefer standard library and Pi's built-in APIs
- **Small, focused changes** — one logical change per commit

### Testing

- Tests live in `extensions/__tests__/`
- Run tests: `npm test` from the repository root. The runner sends `bun:test` files to Bun and the remaining files to Vitest. Bun is required for the Bun-based test files.
- Run diagnostics: `npm run doctor`; use `npm run doctor:strict` before a release or public push.
- Add tests for new tools, utility functions, and security-sensitive code

### Agent Definitions

- Agent `.md` files go in `agents/`
- Use YAML frontmatter: `name`, `description`, `tools`
- Keep system prompts concise and focused on the agent's role
- Add new agents to `teams.yaml` under the appropriate team(s)

### Themes

- Theme JSON files go in `themes/`
- Follow the existing format (see any `.json` file in that directory)
- Test with `/theme <name>` or Ctrl+X to cycle

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes, following the guidelines above
3. Run the test suite and ensure all tests pass
4. Write a clear PR description explaining what and why
5. Reference any related issues

## Reporting Issues

- Use GitHub Issues for bug reports and feature requests
- Include: Pi version, OS, reproduction steps, expected vs actual behavior
- For extension bugs, include the extension name and relevant settings

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
