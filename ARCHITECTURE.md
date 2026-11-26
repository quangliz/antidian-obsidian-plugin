# Antidian Architecture & Technical Reference

This document covers the internal architecture, MCP tool surface, mutation pipeline, session storage, backend management, and development workflow for **Antidian**.

For a user-facing overview, see [README.md](./README.md). For contributor and coding rules, see [AGENTS.md](./AGENTS.md).

## Runtime & Transport Architecture

Antidian delegates reasoning to the official **Antigravity CLI (`agy`)** over ACP (Agent Client Protocol) while enforcing Obsidian vault boundaries through a local loopback HTTP MCP server (`antidian-vault` with bearer token authentication):

```text
AntidianView (Obsidian Sidebar UI)
  → Agent (src/core/agent/)
      → ContextCompiler (active note outline/selection, mode notice)
      → AntigravityProvider / AntigravityAcpClient (spawns `agy acp`)
      → McpToolServer (127.0.0.1 HTTP MCP server `antidian-vault`)
          → ToolRegistry (10 vault tools + `update_focus`)
              → ObsidianVaultAdapter / StagedVaultOverlay / ChangeStagingManager
```

## Module Layout & Boundaries

Antidian enforces a strict one-way dependency boundary (`src/main.ts` → `src/obsidian/` → `src/core/`):

- `src/core/` — Pure harness runtime with **no Obsidian SDK imports**:
  - `agent/` — Agent orchestration loop and default system prompt.
  - `context/` — `ContextCompiler` (deduplicated active note outline/selection, Plan Mode notice, forked context handling).
  - `models/` — ACP client (`antigravity-acp.ts`), ACP form elicitation parser/encoder (`elicitation.ts`), plan/focus progress parser (`plan.ts`), provider wrapper (`antigravity-provider.ts`), local HTTP MCP server (`mcp-tool-server.ts`), managed binary downloader/updater (`agy-binary-manager.ts`), and diagnostics (`agy-diagnostics.ts`).
  - `sessions/` — Trace recording and replay merging (`trace.ts`, including rebuilding image-only turns the CLI does not replay) and `agy` transcript loading (`transcript.ts`).
  - `skills/` — Recognizes skill reads in tool traces (`agy` itself discovers and loads skills).
  - `tools/` — `ToolRegistry` and the tool definitions.
  - `transactions/` — `ChangeStagingManager`, `StagedVaultOverlay`, `ChangeSetValidator`, `ChangeSetDiffGenerator`, `MutationGate`, `ChangeSetApplicator`, and Markdown structural helpers.
  - `types/` — Core domain and service interfaces (`vault`, `context`, `changes`, `model`, `sessions`, `elicitation`, `plan`).
- `src/obsidian/` — Obsidian SDK integration:
  - `adapters/` — `Vault`, `MetadataCache`, `Workspace`, and `Editor` adapters.
  - `commands/` — Command palette registrations and editor context menu hooks.
  - `editor/` — CodeMirror 6 `InlineDiffController` for inline write approvals in open Markdown views.
  - `views/` — Sidebar view, sign-in screen shown instead of the prompt bar until the backend is usable (`sign-in-view.ts`), prompt bar (autocomplete chips, selection chips, drag-and-drop/clipboard media attachments, media preview modal), docked interactive question/poll card (`elicitation-card-view.ts`), thinking trace, diff renderer, model menu, and resizable session drawer.
- `src/main.ts` — Thin composition root that wires services, registers tools/views/commands, and handles lifecycle cleanup.
- `src/settings.ts` — Persisted plugin settings and `AntidianSettingTab`.

## MCP Tools (`antidian-vault`)

Note access goes through `ToolRegistry` exposed over `McpToolServer` so the model never bypasses Obsidian's vault boundaries:

| Category | Tools |
| --- | --- |
| **Read & Explore** | `list_notes`, `get_note_outline`, `search_notes`, `read_note` |
| **Structural Mutations** | `replace_block`, `patch_note`, `append_note`, `update_frontmatter`, `create_note`, `edit_note` |
| **Progress Tracking** | `update_focus` (intercepted into live focus UI; hidden from trace rows) |

`read_note` reads any vault file. Non-text files (`src/core/files.ts`) return a `FileToolResult`, which `McpToolServer` sends as an MCP image/resource block; the bytes never reach the UI or traces. `agy` passes small files straight to the model and offloads larger ones to its own session folder, where the model opens them with the built-in `read_file` (no permission request, no vault access). `agy` has no Office reader (its CLI falls back to shell scripts, which Antidian rejects), so `read_note` returns the text of Office documents itself (`src/core/office.ts`). `ChangeSetValidator` rejects text edits to these files.

`McpToolServer` binds a per-turn `ToolContext` (active context, `permissionMode`, read `mtime` tracking, and `reviewMutation` callback) and blocks mutating tools (`tool.mutates === true`) at the MCP boundary when in `plan` mode.

## Slash Commands & Skills

`agy` owns skills: it discovers `.agents/skills/<name>/SKILL.md` in the vault plus the user's global skills, and the model reads a skill with the built-in `read_file`. For files outside a workspace, such as the vault's skills, `agy` asks permission first. `AntigravityAcpClient.handlePermissionRequest` allows `read_file` only for files inside a skill folder under the roots `skillReadRoots` lists: `<vault>/.agents/skills/` and `~/.agents/skills/` (path check: `isSkillFilePath` in `src/core/skills/`), and refuses every other built-in tool except `SAFE_BUILTIN_TOOLS`. `agy` ends the turn when a tool is refused, so a turn that ends with no text after a refusal replies with the refused tool names (`blockedToolsReply`) instead of an empty answer. Antidian only surfaces skills:

- `agy acp` advertises commands and skills with `available_commands_update` after a session starts. `AntigravityAcpClient` keeps the list for the prompt bar's `/` menu, minus `HIDDEN_COMMANDS` (built-ins that spawn subagents, run on timers, or write files directly). `/clear` is Antidian's own.
- The CLI runs a command or skill that starts the prompt; attached context (below) does not get in its way.
- `/compact` is sent without context, and the active note is re-sent on the next turn. The CLI completes it without a reply, so replay inserts one to keep it apart from the next prompt.

## Turn Context

`ContextCompiler` builds the active note, selection, Plan Mode notice, and forked history as one text. `AntigravityAcpClient` sends it beside the user's text as an embedded `resource` block named by `CONTEXT_RESOURCE_URI`:

- The URI is a `file:` one that names no real file. `agy` inlines resources with other schemes into the user's text, but keeps a `file:` resource apart: replay shows it as a `resource_link`, which Antidian ignores.
- `agy` transcripts mark it as `@[...]` mentions in the request text (removed by `transcript.ts`) and store its body in the metadata that follows, where forked history is read from.
- `stripCompiledContext` is only for sessions from before this, when the blocks were prepended to the prompt.

## Model & Thinking Level

Model choices come from ACP `configOptions` (`model` and `thought_level`), kept as `ModelConfig` and cached in settings for startup. `session/set_config_option` changes them, and `config_option_update` keeps them current:

- `agy` only reports the thinking levels of the current model, and resets both options when a session is loaded, so the client re-applies the wanted values to every session, and starts one when a choice is made without it (such as right after **New session**).
- The levels of each model are cached as they are reported, so the menu can show them before a session has started.
- A wanted level the model does not offer is skipped, and used again with a model that does.
- The model menu shows the levels as a draggable bar (`effort-slider.ts`): a transparent range input inside a native `Menu` item, sent on release. A click on a model keeps the menu open and `refresh()` shows its levels in place. The menu turns off native (macOS) menus for it.
- A model ID saved by an older version (such as `gemini-3.8-flash-low`) is a valid `model` value that also sets the level.

## Interactive Questions (ACP Elicitation)

During ACP `initialize`, `AntigravityAcpClient` advertises `clientCapabilities.elicitation.form: {}`. When the model invokes `agy`'s built-in `ask_question` tool (or another form elicitation), `agy acp` sends a JSON-RPC `elicitation/create` request (`mode: "form"`):

- `src/core/models/elicitation.ts` parses `requestedSchema` into typed fields, pairing `<key>` + `<key>_other` into single-select or multi-select questions with an integrated write-in `"Other"` option and `(Recommended)` badge extraction (while also supporting generic text, number, and boolean fields).
- `ElicitationCardView` renders the interactive card docked above the prompt bar with numbered shortcuts (`1`–`9`), keyboard navigation (`←`/`→`, `↑`/`↓`, `Enter`), stepper tabs for multi-question polls, and **Skip** / **Submit** actions.
- Responses are returned over ACP (`accept` with encoded `content`, `decline`, or `cancel` on turn abort/session switch), and the Q&A summary is recorded on the `ask_question` step in `ThinkingStateView` and reconstructed on session replay.

## Live Step Checklist & Progress Tracking

On multi-step turns, `AntigravityAcpClient` translates `agy`'s built-in `update_steps` / `update_focus` calls (as well as standard ACP `sessionUpdate: "plan"` entries) via `src/core/models/plan.ts` into `plan_update` and `focus_update` step events instead of cluttering the tool trace:

- `ThinkingStateView` renders a live checklist card below the collapsible thinking trace showing `pending`, `in_progress` (animated 4-dot loader), `done`, `skipped`, and `failed` step states, plus a live elapsed timer next to the active focus summary.
- Because `agy`'s transcript logs preserve `update_steps` calls, reopening a stored conversation automatically restores its final checklist state.

## Staged Mutation Pipeline

Write tools do not mutate the vault directly. Every write passes through a transactional pipeline:

```text
tool call
  → ChangeStagingManager (stages operation into a ChangeSet)
  → StagedVaultOverlay (provides read-your-own-writes within the turn)
  → ChangeSetValidator (checks vault path boundaries, stale baseMtime, target uniqueness)
  → ChangeSetDiffGenerator (computes line/hunk diffs)
  → MutationGate (invoked via ToolContext.reviewMutation):
      • ask  → asks for Approve / Reject in the sidebar trace and InlineDiffController,
               and the tool returns `pendingApproval` at once (see below)
      • auto → approves automatically when validation succeeds
      • plan → never staged (blocked at the MCP boundary)
  → ChangeSetApplicator (captures before-state snapshot & applies via ObsidianVaultAdapter)
  → outcome (`applied`, `rejectedByUser`, or an error) reaches the model (UI-only fields stripped)
```

In Ask mode the gate does not hold the MCP request open while the user decides: `agy`'s MCP client gives up after about a minute without response headers. The tool returns `pendingApproval: true` right away, and the approval runs on:

- **Lock**: until decided, the gate refuses further writes to that file, so two pending changes never build on each other.
- **Decision**: on Approve, the gate validates again (the note may have changed meanwhile) and applies; on Reject it discards. `onDecided` sends the final output to the tool row as a second `tool_end`, which enables Undo.
- **Reporting**: `MutationGate.takeReviewNotes()` reports each decision to the model once. `McpToolServer` appends it to the next tool result of the turn; otherwise `Agent.run` adds it, with the files still waiting, to the next turn's context.
- **Lifetime**: an approval can outlast its turn. Leaving the session (new, load, fork, rewind) or closing the view rejects every pending approval, and `forgetDecisions()` drops unreported decisions. Stop rejects only the running turn's approvals.

Applied operations retain before-state snapshots in memory so they can be reverted individually or via `Undo last agent change`.

## Sessions, Traces & Forking

- **Isolated ACP data dir**: `agy acp` is spawned with `--app-data-dir antigravity-antidian` (`~/.gemini/antigravity-antidian/`). Vault conversations stay separate from terminal `agy` CLI `/resume` history while sharing Google authentication. When the data dir of the former plugin id (`antigravity-anti-dian`) exists and the new one does not, `resolveAppDataDir()` keeps using it in place, because `agy` stores absolute paths there.
- **Former plugin id**: `src/core/legacy-names.ts` lists the names stored before the rename from `anti-dian`: old transcripts use the old MCP tool prefix and context path, and `loadLegacySettings()` imports settings from the old plugin folder once.
- **Session discovery & replay**: The session drawer lists vault-scoped sessions via ACP `session/list` and resumes them via `session/load`. Both a chosen model and thinking level are re-applied after a load.
- **Reconnecting**: When the CLI process goes away (crash, changed binary path or certificates, stuck cancel), the next request picks the open conversation up with `session/resume`, which has no replay. If that fails the user gets an error; the client never goes on in a new session, where the agent would have forgotten the conversation. `session/load` stays for opening stored sessions, because an interrupted answer is missing from the CLI's transcript.
- **Local trace enrichment**: Because the CLI does not persist reasoning text, MCP tool outputs, durations, or per-turn usage, `TurnTraceRecorder` saves compacted per-turn traces locally and merges them on replay.
- **Forking & organization**: Forked sessions preserve prior conversation context and store parent–child metadata, custom titles, pinned order, deleted IDs, and drawer width in plugin settings.

## Backend Management & Enterprise Settings

- **Auto-managed binary**: `agy-binary-manager.ts` downloads, SHA-verifies, and installs the `agy` binary on demand, with sidecar version tracking (`agy.version.json`) and background/manual update staging (`.next` swap on restart when locked).
- **Advanced settings** (**Settings → Antidian → Advanced**):
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
