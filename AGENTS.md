# AGENTS.md

Agent rules and guardrails for **Anti-dian** (a desktop-only Obsidian Community Plugin, `isDesktopOnly: true`).
For system architecture, MCP tools, mutation pipeline, and session/backend internals, read [ARCHITECTURE.md](./ARCHITECTURE.md). For user-facing docs, see [README.md](./README.md).

## Core Philosophy
- **General runtime**: Anti-dian is a general-purpose AI noting harness (casual notes, research, journaling, writing, projects). Put domain-specific workflows in Skills (or future Extensions/Packs), not in core TypeScript.
- **Core vs Domain test**: Before adding anything to `src/core/`, ask: *"Is this useful across many unrelated note-taking workflows?"* Never hard-code research or methodology-specific semantics into core.
- **Unstructured vaults are first-class**: Work with existing vaults without requiring PARA, Zettelkasten, atomic notes, folder migrations, or mandatory schemas.
- **Pressure-driven abstractions**: Do not build Pack resolution, Extension hosts, vector search, web/PDF/video ingestion, or unused framework layers before concrete workflows demand them.
- **Terminology**: Use **Tool**, **Skill**, **Schema**, **Extension** (never `plugin` for internal components), **Pack**, and **Profile** consistently.

## Architecture Boundaries
Strict dependency direction:
```text
src/main.ts → src/obsidian/ → src/core/
```

- `src/core/` **MUST NOT** import from `obsidian`.
- Define service contracts in `src/core/types/` and implement them in `src/obsidian/adapters/`.
- Keep pure core modules (`transactions/`, `skills/`, `context/`, `tools/`, `sessions/trace.ts`) free of Node I/O where practical so they remain unit-testable without Obsidian. (`src/core/models/` may use Node APIs for ACP/HTTP/binary management.)
- Keep `src/main.ts` a thin composition root (settings, wiring adapters/services/tools, registering views/commands/icons, `onunload()` cleanup). Do not put retrieval, LLM orchestration, or mutation logic in `main.ts`.
- In `src/obsidian/`, prefer native Obsidian APIs (`Vault`, `FileManager`, `MetadataCache`, `Workspace`, `Editor`) over raw filesystem I/O (dot-folders like `.agents/` are an exception via `app.vault.adapter`).

## Safety & Runtime Invariants
- **Untrusted model output**: Validate paths (`isPathWithinVault`, no `..`, absolute paths, or URI schemes), tool arguments, stale `baseMtime`, scopes, `permissionMode`, and unique match targets.
- **Vault boundary**: All vault access must go through `anti-dian-vault` MCP tools (except `agy` reading skill files itself); never bypass Obsidian via raw CLI filesystem/shell tools.
- **Permission modes**:
  - `ask` (default): Never perform silent unvalidated writes; writes must stage, diff, and wait for approval.
  - `plan`: Read-only; never bypass MCP-layer blocks on mutating tools.
  - `auto`: Validate before applying and still capture before-state snapshots for rollback.
- **Prefer structural edits**: Favor `update_frontmatter`, `replace_block`, `patch_note`, and `append_note` over whole-file rewrites (`edit_note`). Keep affected files inspectable and reversible.
- **Context & privacy**: Never dump the whole vault into context or silently send arbitrary vault content to external services. Never treat Skills as trusted executable code.

## TypeScript & Testing
- Keep boundary types explicit; prefer interfaces for contracts; avoid `any`.
- Keep UI types separate from core types; avoid circular dependencies; prefer small cohesive modules.
- Write core unit tests in `test/*.test.mjs` (Node native test runner with `--experimental-strip-types`, no Obsidian runtime required).

## Workflow & Verification
1. Inspect the relevant implementation and callers first—never infer architecture from file names alone.
2. Implement the smallest complete change while preserving `core` / `obsidian` boundaries.
3. Add or update unit tests in `test/`.
4. Verify before finishing:
   ```bash
   npm test
   npm run lint
   npm run build
   ```
5. Update [README.md](./README.md) or [ARCHITECTURE.md](./ARCHITECTURE.md) when user-facing behavior or architecture changes.
