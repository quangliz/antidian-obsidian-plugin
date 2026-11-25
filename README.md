# Anti-dian

An AI noting assistant for **Obsidian Desktop**, powered by the official **Antigravity CLI (`agy`)**.

Anti-dian works with your existing vault without forcing a folder structure or methodology—pair your notes with safe, reviewable AI edits.

## Highlights

- **Chat with your vault**: Open the sidebar to ask questions, summarize, compare, or draft notes with live active-note context and clickable `[[wikilink]]` previews.
- **Rich input**: Mention notes with `@`, run quick actions with `/` (`/compare`, `/plan`, `/search`, `/summarize`, `/clear`), send selected text via **Add to anti-dian**, or drag-and-drop / paste images, video, and audio.
- **Reads more than notes**: Ask about images, PDFs, audio, video, and Office documents (`.docx`, `.xlsx`, `.pptx`) in your vault (up to 100 MB each), as well as canvases and other text files.
- **Interactive questions**: When clarifying requirements or options, the assistant can present structured single-select or multi-select question cards above the input bar with numbered shortcuts, a write-in **Other** field, and multi-question step navigation.
- **Live planning & progress tracking**: Multi-step turns show an updating step checklist card (`pending`, `in_progress`, `done`, `skipped`, `failed`) below the collapsible thinking trace together with the current focus status and a live elapsed timer.
- **Safe, reviewable edits**:
  - **Ask** *(default)*: Reads are automatic; every edit shows a diff in the sidebar and inline in your note for you to **Accept** or **Reject**.
  - **Plan**: Read-only mode—the assistant can explore and propose changes without modifying files.
  - **Auto**: Applies valid edits immediately.
  - Every applied edit can be rolled back with **Undo**.
- **Organized conversations**: Search, pin, rename, delete, and **fork** conversations in a resizable per-vault drawer.
- **Custom Vault Skills**: Drop reusable Markdown instructions into `.anti-dian/skills/` to teach Anti-dian your own workflows.

## Getting Started

**Requirements**: Obsidian Desktop `1.7.2+` and a Google account.

1. Build the plugin (or copy a release into `<vault>/.obsidian/plugins/anti-dian/`):
   ```bash
   npm install && npm run build
   ```
2. Enable **Anti-dian** in **Settings → Community plugins**.
3. Open **Settings → Anti-dian** and click **Sign in with Google** (the `agy` backend downloads automatically on first use).
4. Open the sidebar from the ribbon icon or run `Anti-dian: Open sidebar`.

## Useful Commands

- `Anti-dian: Open sidebar` — Open or focus the chat sidebar.
- `Anti-dian: Add selection to chat` — Attach the current editor selection (also in the editor right-click menu as **Add to anti-dian**).
- `Anti-dian: Accept pending inline diff change` / `Reject pending inline diff change` — Review edits directly from the editor.
- `Anti-dian: Undo last agent change` — Revert the most recent edit.

## Vault Skills

Create `.anti-dian/skills/<name>.md` (or `.anti-dian/skills/<name>/SKILL.md`) with optional frontmatter:

```markdown
---
name: daily-review
description: Summarize today's notes and extract open action items.
---

# Daily Review
...
```

Anti-dian discovers your skills automatically and loads them on demand.

## Privacy & Network Use

- **Google account & AI requests**: Anti-dian authenticates with your Google account and sends your prompts, attached media, and the notes and files accessed during a conversation to Google's Antigravity backend via the `agy` CLI. It never uploads your entire vault.
- **Backend binary**: If `agy` is not already installed, Anti-dian downloads and verifies the official Antigravity CLI binary from Google's release endpoint (or you can provide a local binary path in **Settings → Anti-dian → Advanced**).

## Technical Details & Development

For architecture, MCP vault tools, the mutation/diff pipeline, backend configuration, and development scripts, see [ARCHITECTURE.md](./ARCHITECTURE.md) (and [AGENTS.md](./AGENTS.md) for contributor guidelines).
