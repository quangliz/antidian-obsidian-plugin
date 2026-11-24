# Anti-dian

A general-purpose AI noting harness for Obsidian, powered by the official **Antigravity CLI (`agy`)** over ACP (Agent Client Protocol).

Anti-dian works with your existing vault without forcing a specific note-taking methodology (PARA, Zettelkasten, or mandatory schemas). It pairs Obsidian-native context with a safe, inspectable mutation pipeline.

## Features

- **Obsidian-native sidebar**: Stream reasoning and answers alongside live active note and editor selection context, model selection, quota/context usage, and clickable `[[wikilink]]` references.
- **Structured vault tools (via local MCP)**: Exposes vault operations to the Antigravity CLI through a loopback MCP server (`anti-dian-vault`) so the agent never bypasses Obsidian's vault boundaries:
  - Read & explore: `list_notes`, `get_note_outline`, `search_notes`, `read_note`
  - Structural mutations: `replace_block`, `patch_note`, `append_note`, `update_frontmatter`, `create_note`, `edit_note`
  - Vault skills: `list_skills`, `load_skill`
- **Staged mutations, diff & rollback**: Write operations are staged into a `ChangeSet`, reflected immediately to subsequent reads within the same turn (`StagedVaultOverlay`), validated for path safety and stale edits, rendered as a diff, and backed by before-state snapshots for rollback.
- **Permission modes**:
  - `Ask` (default): Free reads; writes require review and approval.
  - `Plan`: Read-only analysis; write tools are blocked at the MCP layer.
  - `Auto`: Valid staged mutations are auto-applied (snapshots are still captured for rollback).
- **Vault Skills**: Add reusable Markdown workflows in `.anti-dian/skills/` without modifying plugin code.

## Requirements

- **Obsidian Desktop** `1.7.2` or newer (desktop-only plugin).
- **Antigravity CLI (`agy`)** installed on your `PATH` or `~/.local/bin/agy` (or configured manually in plugin settings).

## Setup

1. Install dependencies and build the plugin:
   ```bash
   npm install
   npm run build
   ```
2. Enable **Anti-dian** in Obsidian under **Settings → Community plugins**.
3. Open **Settings → Anti-dian**:
   - Confirm the Antigravity CLI path (leave blank to auto-detect).
   - Click **Sign in with Google** if not already authenticated.
   - Choose your default model and permission mode (`Ask`, `Plan`, or `Auto`).
4. Open the sidebar using the ribbon icon or the command palette (`Anti-dian: Open sidebar`).

## Vault Skills

Place custom workflow instructions inside your vault under `.anti-dian/skills/`:

- Single-file skill: `.anti-dian/skills/<name>.md`
- Folder skill: `.anti-dian/skills/<name>/SKILL.md`

Optional YAML frontmatter supports `name` and `description`:

```markdown
---
name: daily-review
description: Summarize today's notes and extract open action items.
---

# Daily Review
...
```

Available skills are summarized once per session in context and loaded on demand via `load_skill`.

## Architecture

Anti-dian separates general harness logic from Obsidian integration:

- `src/core/` — Pure harness runtime (`agent`, `context`, `models`, `skills`, `tools`, `transactions`, `types`). Never imports from `obsidian`.
- `src/obsidian/` — Obsidian adapters (`Vault`, `MetadataCache`, `Workspace`, `Editor`), commands, and sidebar views.
- `src/main.ts` — Thin composition root.

See [AGENTS.md](./AGENTS.md) for detailed architecture rules and contribution guidelines.

## Development

```bash
npm run dev     # Watch mode build (esbuild)
npm test        # Run core unit tests (Node native test runner)
npm run lint    # Run ESLint + obsidianmd rules
npm run build   # Typecheck (tsc) + production build
```
