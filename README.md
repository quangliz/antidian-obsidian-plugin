<p align="center">
  <img src="assets/logo.png" alt="Antidian logo" width="140">
</p>

# Antidian

**Antigravity for Obsidian.** Antidian brings Google's Antigravity agent into your vault, powered by the official **Antigravity CLI (`agy`)**.

Chat with your notes, and let the agent read, write, and edit them with you. It works with the vault you already have, and edits can be reviewed and undone.

## Install

**Requirements**: Obsidian Desktop `1.7.2+` and a Google account.

1. [Open Antidian in Obsidian](obsidian://show-plugin?id=antidian), then install and enable it. If the link is not clickable, paste this into your browser:
   ```text
   obsidian://show-plugin?id=antidian
   ```
2. Open the sidebar from the ribbon icon or run `Antidian: Open sidebar`.
3. Click **Sign in with Google** there, or in **Settings → Antidian**. The `agy` backend is downloaded first if it is missing.

## How It Works

Antidian runs `agy` in the background and talks to it over the **Agent Client Protocol (ACP)**:

- **From `agy`**: the agent itself, along with its models, conversations, slash commands, and skills.
- **From Antidian**: its own **MCP server**, which gives the agent tools to search, read, and edit your vault through Obsidian, plus the chat interface, file attachments, and inline edit review (`Ask`, `Plan`, or `Auto` modes).

## MCP Servers & Companion Plugins

Extend Antidian with additional tools in **Settings → Antidian → MCP servers**:

- **Companion plugins (zero setup)**: Enabled Obsidian plugins whose ID ends with `-antidian` (such as **Excalidraw MCP**, `excalidraw-mcp-antidian`) are detected automatically over local loopback HTTP (`127.0.0.1` / `localhost`) and can be toggled on or off individually.
- **Custom MCP servers**: Add, edit, toggle, or remove local `stdio` or remote `HTTP` MCP servers directly in Settings (shared with `mcp_config.json`). Changes apply to new conversations.

## Privacy & Network Use

- **Google account & AI requests**: Antidian authenticates with your Google account and sends your prompts, attached media, and the notes and files accessed during a conversation to Google's Antigravity backend via the `agy` CLI. It never uploads your entire vault.
- **Backend binary**: If `agy` is not already installed, Antidian downloads and verifies the official Antigravity CLI binary from Google's release endpoint (or you can provide a local binary path in **Settings → Antidian → Advanced**).
- **No telemetry**: Antidian has no analytics of its own. The only server it runs is the MCP server, which listens on `127.0.0.1` and requires a bearer token.

### Coming from Anti-dian

Up to 1.0.1 the plugin was listed as Anti-dian (id `anti-dian`). Obsidian treats the new id as a separate plugin:

1. Install and enable Antidian. It imports your Anti-dian settings on first start and keeps showing your conversations.
2. Disable and uninstall Anti-dian, then reopen the sidebar. Custom hotkeys have to be assigned again.

### Why it needs these permissions

Antidian drives a local agent process, so Obsidian's automated review lists these capabilities on the plugin page:

- **Shell execution** (`child_process`): starts the `agy` binary directly, without a shell, and runs `tar` to unpack its download. The agent gets no shell: its requests to run commands or write files with its built-in tools are rejected, and vault access goes through the MCP server, so its built-in file tools cannot open your vault. Without asking, it may read skill files (`<vault>/.agents/skills/`, `~/.agents/skills/`, `~/.gemini/config/skills/`), the MCP tool schemas `agy` keeps in `~/.gemini/<app-data-dir>/mcp/<server>/`, and offloaded tool outputs for the current session under `~/.gemini/<app-data-dir>/brain/<session>/.system_generated/`, and it may search and open web pages. Anything else it wants to run, such as reading a file elsewhere on your computer, waits for you to choose **Allow once**, **Allow for this session**, or **Deny**. Calls to MCP servers you add yourself and enabled local `*-antidian` companion plugins are allowed, and asked about in Plan mode. When a tool is refused, `agy` ends the turn: Antidian says which tool and why, with a **Continue** button.
- **Filesystem access outside the vault** (`fs`): installs and updates `agy` in `~/.gemini/bin`, reads and deletes this plugin's conversations and logs under `~/.gemini`, and reads a certificate file you configure or files you attach by pasting or dropping.
- **Vault enumeration**: lists files so the agent can search your vault and you can `@`-mention notes. Searching happens locally; only the results the agent asked for are sent.
- **Clipboard**: copies a message when you press its copy button, and reads copied file paths when you paste into the prompt.
