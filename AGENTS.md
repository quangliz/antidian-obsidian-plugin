# AGENTS.md

## Project
Anti-dian is a general-purpose AI noting harness implemented as a **desktop-only Obsidian Community Plugin** (`isDesktopOnly: true`).

It must support casual notes, research, journaling, learning, writing, projects, and custom workflows without forcing one methodology.

> Keep the runtime general. Put domain-specific behavior in Skills, Schemas, Extensions, Packs, and Profiles.

## Repository
```text
anti-dian/
├── src/
│   ├── core/
│   │   ├── agent/         # Agent orchestration loop & system prompt
│   │   ├── context/       # ContextCompiler (session skills, mode notice, active note/selection)
│   │   ├── models/        # Antigravity CLI (ACP) client, provider, local HTTP MCP tool server
│   │   ├── skills/        # Pure Markdown skill parser & constants
│   │   ├── tools/         # ToolRegistry and vault/skill tool definitions
│   │   ├── transactions/  # ChangeStagingManager, StagedVaultOverlay, Validator, Diff, Applicator
│   │   └── types/         # Core domain & service contracts (vault, context, changes, model, skills)
│   ├── obsidian/
│   │   ├── adapters/      # Vault, Metadata, Workspace, Editor, Skills adapters
│   │   ├── commands/      # Obsidian command registrations
│   │   ├── views/         # Sidebar view, prompt bar, diff table, thinking trace, model menu
│   │   └── icon.ts        # Custom ribbon/view icon registration
│   ├── main.ts            # Composition root / plugin entrypoint
│   └── settings.ts        # Plugin settings & setting tab
├── test/                  # Node native unit tests (no Obsidian runtime required)
├── manifest.json
├── styles.css
├── package.json
└── ...
```

Boundary:
```text
src/core/      General harness logic (no Obsidian SDK imports)
src/obsidian/  Obsidian-specific adapters, commands, and views
src/main.ts    Composition root / plugin entrypoint
```

## Core Rules
- `src/core/` MUST NOT import from `obsidian`.
- Core contains agent orchestration, tools, context compilation, transactions, skill parsing, model/MCP transport, and shared contracts.
- Define stable interfaces in `src/core/types/`; implement them in `src/obsidian/adapters/`.
- Note: `src/core/models/` uses Node.js APIs (`child_process`, `http`, `fs`, `crypto`) because the plugin is desktop-only and communicates with the local Antigravity CLI. Keep pure logic modules (such as `transactions/`, `skills/`, `context/`, `tools/`) free of Node-specific I/O where practical so they stay easy to test.
- Do not create unused framework layers or empty directories in advance.

Example contract (`src/core/types/vault.ts`):
```ts
export interface VaultService
  extends VaultInspectionService,
    VaultMutationService {
  searchNotes(params: SearchNotesParams): Promise<SearchResult[]>;
  readNote(params: ReadNoteParams): Promise<NoteContent | null>;
  listNotes?(params?: ListNotesParams): Promise<NoteListItem[]>;
  getNoteOutline?(path: string): Promise<NoteOutline | null>;
}
```

## Runtime & Transport Architecture
Anti-dian delegates reasoning to the official **Antigravity CLI (`agy`)** via ACP (Agent Client Protocol) while enforcing Obsidian safety boundaries through a local MCP server:

```text
AntiDianView (Obsidian UI)
  → Agent (src/core/agent/)
      → ContextCompiler (deduplicated active note/selection, outline hint, skills list, mode notice)
      → AntigravityProvider / AntigravityAcpClient (spawns `agy` CLI over ACP)
      → McpToolServer (127.0.0.1 HTTP MCP server `anti-dian-vault` with bearer token)
          → ToolRegistry (12 vault & skill tools)
              → ObsidianVaultAdapter / StagedVaultOverlay / ChangeStagingManager / ObsidianSkillAdapter
```

Key invariants:
- `agy acp` is spawned with `--app-data-dir antigravity-anti-dian` (`ANTI_DIAN_APP_DATA_DIR`), so Anti-dian conversations live in `~/.gemini/antigravity-anti-dian/` and never show up in the user's `agy` CLI `/resume` list. Login is shared across data dirs.
- Vault operations MUST go through the `anti-dian-vault` MCP tools; the model must never bypass Obsidian via raw CLI filesystem/shell tools.
- `McpToolServer` binds per-turn `ToolContext` (active context, `permissionMode`, read mtimes, context recording) and enforces Plan Mode by rejecting mutating tools (`tool.mutates === true`).
- Three permission modes are supported (`src/settings.ts`):
  - `ask` (default): free reads; each write tool call pauses for per-call approval (diff + Approve/Reject on its tool row) before the tool returns, so the model learns the outcome immediately.
  - `plan`: read-only; mutating tools are blocked at the MCP boundary.
  - `auto`: each valid write is applied as soon as its tool call stages it, still capturing a before-state snapshot for per-call undo.

## Obsidian Layer
`src/obsidian/` may use the Obsidian SDK.

Prefer native APIs:
```text
read/write       -> Vault
rename/move/del  -> FileManager / Vault
links/backlinks  -> MetadataCache
active note      -> Workspace
selection/cursor -> Editor
```

Avoid raw filesystem mutation when native APIs are appropriate. (Note: `ObsidianSkillAdapter` reads `.anti-dian/skills/` via `app.vault.adapter` because dot-folders are hidden from `Vault.getMarkdownFiles()`.)

## main.ts
Keep `src/main.ts` small. It should only:
- load/save settings
- construct adapters and core services
- register tools on `ToolRegistry`
- construct `McpToolServer`, `AntigravityProvider`, and `Agent`
- register views, hover link source, ribbon icon, commands, and setting tab
- register cleanup in `onunload()`

Do not put retrieval, LLM orchestration, or mutation logic in `main.ts`.

## Current Status & Priorities
Implemented foundation:
- Sidebar chat UI with streaming thoughts/answers, tool trace, model picker, quota/context usage, and permission mode selector
- Session manager in the top nav (`SessionMenuController`): lists this vault's stored sessions via ACP `session/list` (filtered to the vault cwd), resumes one via `session/load` (replays messages, thoughts and tool calls into the same trace view; injected context stripped by `stripCompiledContext`; per-turn token usage is not replayed by the CLI), and shows the CLI-generated session title
- Active note + selection tracking (`ObsidianWorkspaceAdapter` + `ObsidianEditorAdapter`)
- `ContextCompiler` with session-level skill injection, Plan Mode notice, and deduplicated active note outline + selection
- 12 MCP tools: `list_notes`, `get_note_outline`, `search_notes`, `read_note`, `create_note`, `patch_note`, `replace_block`, `append_note`, `update_frontmatter`, `edit_note`, `list_skills`, `load_skill`
- Transactional mutation pipeline: `ChangeStagingManager` → `StagedVaultOverlay` (read-your-own-writes within a turn) → `ChangeSetValidator` → `ChangeSetDiffGenerator` → per-call review in `MutationGate` (approve/reject in the tool trace) → `ChangeSetApplicator` (with before-state snapshot & per-call undo)
- Vault Skills loaded from `.anti-dian/skills/`

Next priorities:
- Extract search ranking/fusion from `ObsidianVaultAdapter.searchNotes` into `src/core/retrieval/` when retrieval grows beyond basic scoring
- Add native `rename`/`move` mutation primitives using `FileManager.renameFile`
- Improve persistent ChangeSet history / multi-step undo beyond in-memory snapshots
- Only after real workflows demand them: Extensions, semantic retrieval, external sources, Packs, and Profiles

Do not build Pack infrastructure, vector search, or web/PDF/video ingestion until concrete workflows require them.

## Retrieval
Do not make vector search the foundation.

Start with:
- title/path
- exact text
- headings
- properties/tags
- wikilinks/backlinks
- active-note context
- scope (folder/tag filters)
- recency (`mtime`) where useful

Target separation:
```text
retrieval        finds candidates (currently in ObsidianVaultAdapter)
ranking/fusion   prioritizes candidates (to be extracted to src/core/retrieval/ as needed)
context compiler builds final model context (src/core/context/compiler.ts)
```

Prefer Markdown-aware headings/sections over arbitrary chunks when practical.
Vector search may later be one provider.

## Mutation
Prefer structural edits over whole-file rewrites:
- `update_frontmatter` (set/remove YAML properties)
- `replace_block` (targeted unique exact-text replacement)
- `patch_note` (replace a heading section)
- `append_note` (append to note or under a heading)
- `create_note` (new file)
- `edit_note` (full-file rewrite, fallback only)
- Planned: native `rename`/`move` via `FileManager`

Pipeline:
```text
tool request
→ stage ChangeSet (ChangeStagingManager)
→ overlay reads within turn (StagedVaultOverlay)
→ validate (ChangeSetValidator: path boundary, stale mtime, conflicts, target checks)
→ diff (ChangeSetDiffGenerator)
→ per-call review (MutationGate, invoked by McpToolServer via ToolContext.reviewMutation):
    ask  → the tool call waits for Approve / Reject on its row in the thinking trace
    auto → approved automatically when valid
    plan → never staged (blocked at the MCP boundary)
→ capture snapshot & apply that single operation immediately (ChangeSetApplicator + ObsidianVaultAdapter)
→ tool result tells the model `applied` or `rejectedByUser` (UI-only fields like `_diff` are stripped)
→ undo per call via snapshot when requested
```

Do not silently perform unvalidated or high-impact writes in default (`ask`) mode.
A ChangeSet must keep affected files and operations inspectable.
Support rejection before apply and rollback after apply.

## Extension Model
Use these terms consistently:

- **Tool** *(implemented)*: model-callable operation exposed via `ToolRegistry` / MCP (e.g., `search_notes`, `read_note`, `patch_note`).
- **Skill** *(implemented)*: dynamically loaded instruction-defined workflow stored in `.anti-dian/skills/<name>.md` or `.anti-dian/skills/<name>/SKILL.md`, progressively disclosed via `ContextCompiler` and `load_skill`.
- **Schema** *(planned)*: domain-specific structure; core must not hard-code its semantics.
- **Extension** *(planned)*: executable Anti-dian capability such as Zotero, semantic search, calendar, or PDF processing.
- **Pack** *(planned)*: composition/distribution of Skills, Schemas, Templates, Policies, retrieval config, and optional Extensions.
- **Profile** *(planned)*: selected/scoped composition for a user, vault, project, or folder.

Use `Extension`, not `plugin`, for internal executable components.
Do not make Pack a runtime god object.
A new workflow should normally not require editing core TypeScript.

## Core vs Domain Logic
Before adding something to core, ask:

> Is this useful across many unrelated note-taking workflows?

General examples:
```text
search
read
extract(schema)
classify(schema)
compare
link
split
merge
stage
diff
apply
rollback
```

Skill/Pack examples:
```text
verify_claim
survey_literature
daily_reflection
track_mood
prepare_meeting
make_flashcards
```

Do not hard-code research semantics into core.

## Obsidian UX
Anti-dian must work with existing vaults.

Do not require users to:
- adopt PARA
- adopt Zettelkasten
- make every note atomic
- migrate folders
- add mandatory schemas

> Structured vaults get more leverage, but unstructured vaults remain first-class.

Use native context when useful: active file, selected text, workspace state, MetadataCache, wikilinks, and properties.

## Model Safety
Treat model output as untrusted input.

Validate:
- paths (`isPathWithinVault`, no `..`, absolute paths, or URI schemes)
- tool arguments
- operations and stale `baseMtime`
- scopes and `permissionMode`
- schemas
- resource existence and unique match targets

Never allow an LLM-provided path to escape allowed vault boundaries.
Do not dump the whole vault into context.
Do not silently send arbitrary vault content to external services.

## TypeScript
- Keep boundary types explicit.
- Prefer interfaces for service/provider contracts.
- Avoid `any` unless unavoidable.
- Validate untrusted runtime data.
- Keep UI types separate from core types.
- Avoid circular dependencies.
- Prefer small cohesive modules.

Dependency direction:
```text
main.ts
  ↓
src/obsidian
  ↓
src/core
```

Never allow `src/core` to depend on the Obsidian SDK.

## Abstraction Rule
Keep abstractions pressure-driven.

Do not build:
- a registry for one provider
- Pack resolution before a real Pack exists
- a complex extension host before isolation is needed
- a large model-provider framework before multiple providers exist

Small interfaces protecting the `core` / `obsidian` boundary are encouraged early.

## Testing
Prefer core tests without Obsidian (run via Node's native test runner with `--experimental-strip-types`).

Use:
- unit tests in `test/*.test.mjs` for parsing, validation, overlay, diffing, context compilation, and MCP server behavior
- fixture vaults / mock `VaultService` for search, links, and mutations
- manual Obsidian tests for views, commands, editor context, and diff UX

## Development Workflow
Before a substantial change:
1. Read this file.
2. Inspect the relevant implementation.
3. Search related interfaces and callers.
4. Preserve `core` / `obsidian` boundaries.
5. Implement the smallest complete behavior.
6. Add/update tests in `test/`.
7. Verify with:
   - `npm test` (core unit tests)
   - `npm run lint` (ESLint + `eslint-plugin-obsidianmd`)
   - `npm run build` (`tsc -noEmit -skipLibCheck` + production esbuild bundle)
8. Manually test Obsidian behavior if views, adapters, or commands changed.
9. Update `AGENTS.md` and `README.md` when public contracts or architecture change.

Do not infer architecture only from file names.

## Anti-Patterns
Do not:
- turn Anti-dian into a research-only assistant
- hard-code domain workflows into core
- make vector search the only retrieval path
- dump the whole vault into context
- import Obsidian SDK from `src/core/`
- perform silent unvalidated writes in `ask` mode or bypass Plan Mode blocks
- bypass native Obsidian APIs without reason
- make Packs executable god objects
- treat Skills as trusted executable code
- over-engineer before concrete use cases exist
- accumulate application logic in `main.ts`

## Final Principle
Prefer composability over hard-coded specialization, but do not build extensibility infrastructure before real workflows require it.

> Build a small general runtime with strong Obsidian-native context and safe mutation primitives, then extend it progressively.
