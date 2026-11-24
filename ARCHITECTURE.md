# Anti-dian Architecture & Technical Reference

This document covers the internal architecture, MCP tool surface, mutation pipeline, session storage, backend management, and development workflow for **Anti-dian**.

For a user-facing overview, see [README.md](./README.md). For contributor and coding rules, see [AGENTS.md](./AGENTS.md).

## Runtime & Transport Architecture

Anti-dian delegates reasoning to the official **Antigravity CLI (`agy`)** over ACP (Agent Client Protocol) while enforcing Obsidian vault boundaries through a local loopback HTTP MCP server (`anti-dian-vault` with bearer token authentication):

```text
AntiDianView (Obsidian Sidebar UI)
  → Agent (src/core/agent/)
      → ContextCompiler (active note outline/selection, session skills, mode notice)
      → AntigravityProvider / AntigravityAcpClient (spawns `agy acp`)
      → McpToolServer (127.0.0.1 HTTP MCP server `anti-dian-vault`)
          → ToolRegistry (12 vault & skill tools)
              → ObsidianVaultAdapter / StagedVaultOverlay / ChangeStagingManager / ObsidianSkillAdapter
```

## Module Layout & Boundaries

Anti-dian enforces a strict one-way dependency boundary (`src/main.ts` → `src/obsidian/` → `src/core/`):

- `src/core/` — Pure harness runtime with **no Obsidian SDK imports**:
  - `agent/` — Agent orchestration loop and default system prompt.
  - `context/` — `ContextCompiler` (deduplicated active note outline/selection, skill summaries, Plan Mode notice, forked context handling).
  - `models/` — ACP client (`antigravity-acp.ts`), provider wrapper (`antigravity-provider.ts`), local HTTP MCP server (`mcp-tool-server.ts`), managed binary downloader/updater (`agy-binary-manager.ts`), and diagnostics (`agy-diagnostics.ts`).
  - `sessions/` — `TurnTraceRecorder` (`trace.ts`) and transcript/replay helpers (`transcript.ts`).
  - `skills/` — Pure Markdown skill parser and constants.
  - `tools/` — `ToolRegistry` and 12 tool definitions.
  - `transactions/` — `ChangeStagingManager`, `StagedVaultOverlay`, `ChangeSetValidator`, `ChangeSetDiffGenerator`, `MutationGate`, `ChangeSetApplicator`, and Markdown structural helpers.
  - `types/` — Core domain and service interfaces (`vault`, `context`, `changes`, `model`, `sessions`, `skills`).
- `src/obsidian/` — Obsidian SDK integration:
  - `adapters/` — `Vault`, `MetadataCache`, `Workspace`, `Editor`, and `Skills` adapters.
  - `commands/` — Command palette registrations and editor context menu hooks.
  - `editor/` — CodeMirror 6 `InlineDiffController` for inline write approvals in open Markdown views.
  - `views/` — Sidebar view, prompt bar (autocomplete chips, selection chips, drag-and-drop/clipboard media attachments, media preview modal), thinking trace, diff renderer, model menu, and resizable session drawer.
- `src/main.ts` — Thin composition root that wires services, registers tools/views/commands, and handles lifecycle cleanup.
- `src/settings.ts` — Persisted plugin settings and `AntiDianSettingTab`.

## MCP Tools (`anti-dian-vault`)

All vault access goes through `ToolRegistry` exposed over `McpToolServer` so the model never bypasses Obsidian's vault boundaries:

| Category | Tools |
| --- | --- |
| **Read & Explore** | `list_notes`, `get_note_outline`, `search_notes`, `read_note` |
| **Structural Mutations** | `replace_block`, `patch_note`, `append_note`, `update_frontmatter`, `create_note`, `edit_note` |
| **Vault Skills** | `list_skills`, `load_skill` |

`McpToolServer` binds a per-turn `ToolContext` (active context, `permissionMode`, read `mtime` tracking, and `reviewMutation` callback) and blocks mutating tools (`tool.mutates === true`) at the MCP boundary when in `plan` mode.

## Staged Mutation Pipeline

Write tools do not mutate the vault directly. Every write passes through a transactional pipeline:

```text
tool call
  → ChangeStagingManager (stages operation into a ChangeSet)
  → StagedVaultOverlay (provides read-your-own-writes within the turn)
  → ChangeSetValidator (checks vault path boundaries, stale baseMtime, target uniqueness)
  → ChangeSetDiffGenerator (computes line/hunk diffs)
  → MutationGate (invoked via ToolContext.reviewMutation):
      • ask  → pauses for Approve / Reject in the sidebar trace and InlineDiffController
      • auto → approves automatically when validation succeeds
      • plan → never staged (blocked at the MCP boundary)
  → ChangeSetApplicator (captures before-state snapshot & applies via ObsidianVaultAdapter)
  → tool returns `applied` or `rejectedByUser` to the model (UI-only fields stripped)
```

Applied operations retain before-state snapshots in memory so they can be reverted individually or via `Undo last agent change`.

## Sessions, Traces & Forking

- **Isolated ACP data dir**: `agy acp` is spawned with `--app-data-dir antigravity-anti-dian` (`~/.gemini/antigravity-anti-dian/`). Vault conversations stay separate from terminal `agy` CLI `/resume` history while sharing Google authentication.
- **Session discovery & replay**: The session drawer lists vault-scoped sessions via ACP `session/list` and resumes them via `session/load`. `stripCompiledContext` removes injected context blocks during replay.
- **Local trace enrichment**: Because the CLI does not persist reasoning text, MCP tool outputs, durations, or per-turn usage, `TurnTraceRecorder` saves compacted per-turn traces locally and merges them on replay.
- **Forking & organization**: Forked sessions preserve prior conversation context and store parent–child metadata, custom titles, pinned order, deleted IDs, and drawer width in plugin settings.

## Backend Management & Enterprise Settings

- **Auto-managed binary**: `agy-binary-manager.ts` downloads, SHA-verifies, and installs the `agy` binary on demand, with sidecar version tracking (`agy.version.json`) and background/manual update staging (`.next` swap on restart when locked).
- **Advanced settings** (**Settings → Anti-dian → Advanced**):
  - **Custom binary path**: Override the managed `agy` binary path.
  - **Custom root certificates**: Path to a PEM CA bundle trusted when downloading or running the backend behind a corporate TLS/VPN proxy.
  - **Show raw tool data**: Display raw tool arguments and outputs in the thinking trace for debugging.

## Development

```bash
npm install     # Install dependencies
npm run dev     # Watch mode build (esbuild)
npm test        # Run core unit tests (Node native test runner, no Obsidian runtime required)
npm run lint    # Run ESLint + eslint-plugin-obsidianmd rules
npm run build   # Typecheck (tsc -noEmit) + production esbuild bundle
```
