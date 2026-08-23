# AGENTS.md

## Project
Anti-dian is a general-purpose AI noting harness implemented as an **Obsidian Community Plugin**.

It must support casual notes, research, journaling, learning, writing, projects, and custom workflows without forcing one methodology.

> Keep the runtime general. Put domain-specific behavior in Skills, Schemas, Extensions, Packs, and Profiles.

## Repository
```text
anti-dian/
├── src/
│   ├── core/
│   ├── obsidian/
│   ├── main.ts
│   └── settings.ts
├── manifest.json
├── styles.css
├── package.json
└── ...
```

Boundary:
```text
src/core/      General harness logic
src/obsidian/  Obsidian-specific integration
src/main.ts    Composition root / plugin entrypoint
```

## Core Rules
- `src/core/` MUST NOT import from `obsidian`.
- Core may contain agent, tools, retrieval, context compilation, transactions, skills, model abstractions, and shared contracts.
- Define stable interfaces in core; implement them in `src/obsidian/`.
- Do not create unused framework layers or empty directories in advance.

Example:
```ts
export interface VaultService {
  read(path: string): Promise<Note>;
  search(query: string): Promise<SearchResult[]>;
}
```

## Obsidian Layer
`src/obsidian/` may use the Obsidian SDK.

Prefer native APIs:
```text
read/write       -> Vault
rename/move      -> FileManager / Vault
links/backlinks  -> MetadataCache
active note      -> Workspace
selection        -> Editor
```

Avoid raw filesystem mutation when native APIs are appropriate.

## main.ts
Keep `src/main.ts` small. It should only:
- load settings
- construct adapters/services
- construct runtime
- register views/commands
- register cleanup

Do not put retrieval, LLM orchestration, or mutation logic in `main.ts`.

## Current Priority
Build this vertical slice first:
```text
sidebar
→ active note + selection
→ search_notes
→ read_note
→ minimal agent loop
→ staged create/patch
→ diff + approval
→ undo/history
```

Only then prioritize Skills, better Context Compiler, Extensions, semantic retrieval, external sources, Packs, and Profiles.

Do not build Pack infrastructure, vector search, or web/PDF/video ingestion before the basic loop works.

## Retrieval
Do not make vector search the foundation.

Start with:
- title/path
- exact text
- headings
- properties/tags
- wikilinks/backlinks
- active-note context
- scope
- recency where useful

Keep separate:
```text
retrieval        finds candidates
ranking/fusion   prioritizes candidates
context compiler builds final model context
```

Prefer Markdown-aware headings/sections over arbitrary chunks when practical.
Vector search may later be one provider.

## Mutation
Prefer structural edits over whole-file rewrites:
- set property
- insert under heading
- replace section
- append block
- native rename/move

Target flow:
```text
tool request
→ stage ChangeSet
→ validate
→ diff
→ approve
→ apply
→ record history
```

Do not silently perform high-impact writes.
A ChangeSet must keep affected files and operations inspectable.
Support rejection before apply and rollback where feasible.

## Extension Model
Use these terms consistently:

- **Tool**: model-callable operation such as `search_notes`, `read_note`, `patch_note`.
- **Skill**: dynamically loaded instruction-defined workflow.
- **Schema**: domain-specific structure; core must not hard-code its semantics.
- **Extension**: executable Anti-dian capability such as Zotero, semantic search, calendar, or PDF processing.
- **Pack**: composition/distribution of Skills, Schemas, Templates, Policies, retrieval config, and optional Extensions.
- **Profile**: selected/scoped composition for a user, vault, project, or folder.

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
- paths
- tool arguments
- operations
- scopes
- schemas
- resource existence

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
- a large model-provider framework before the minimal path works

Small interfaces protecting the `core` / `obsidian` boundary are encouraged early.

## Testing
Prefer core tests without Obsidian.

Use:
- unit tests for parsing/ranking/validation
- fixture vaults for search/links/mutations
- integration tests for adapters where practical
- manual Obsidian tests for views, commands, editor context, and diff UX

## Development Workflow
Before a substantial change:
1. Read this file.
2. Inspect the relevant implementation.
3. Search related interfaces and callers.
4. Preserve `core` / `obsidian` boundaries.
5. Implement the smallest complete behavior.
6. Add/update tests.
7. Run typecheck, lint, and build.
8. Manually test Obsidian behavior if affected.
9. Update docs when public contracts or architecture change.

Do not infer architecture only from file names.

## Anti-Patterns
Do not:
- turn Anti-dian into a research-only assistant
- hard-code domain workflows into core
- make vector search the only retrieval path
- dump the whole vault into context
- import Obsidian SDK from `src/core/`
- perform silent high-impact writes
- bypass native Obsidian APIs without reason
- make Packs executable god objects
- treat Skills as trusted executable code
- over-engineer before concrete use cases exist
- accumulate application logic in `main.ts`

## Final Principle
Prefer composability over hard-coded specialization, but do not build extensibility infrastructure before real workflows require it.

> Build a small general runtime with strong Obsidian-native context and safe mutation primitives, then extend it progressively.