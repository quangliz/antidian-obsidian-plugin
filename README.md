<p align="center">
  <img src="assets/logo.png" alt="Anti-dian logo" width="140">
</p>

# Anti-dian

**Antigravity for Obsidian.** Anti-dian brings Google's Antigravity agent into your vault, powered by the official **Antigravity CLI (`agy`)**.

Chat with your notes, and let the agent read, write, and edit them with you. It works with the vault you already have, and edits can be reviewed and undone.

## Install

**Requirements**: Obsidian Desktop `1.7.2+` and a Google account.

1. [Open Anti-dian in Obsidian](obsidian://show-plugin?id=anti-dian), then install and enable it. If the link is not clickable, paste this into your browser:
   ```text
   obsidian://show-plugin?id=anti-dian
   ```
2. Open **Settings → Anti-dian** and click **Sign in with Google**. The `agy` backend downloads automatically on first use.
3. Open the sidebar from the ribbon icon or run `Anti-dian: Open sidebar`.

## How It Works

Anti-dian runs `agy` in the background and talks to it over the **Agent Client Protocol (ACP)**:

- **From `agy`**: the agent itself, along with its models, conversations, slash commands, and skills.
- **From Anti-dian**: its own **MCP server**, which gives the agent tools to search, read, and edit your vault through Obsidian, plus the chat interface and edit review.

## Privacy & Network Use

- **Google account & AI requests**: Anti-dian authenticates with your Google account and sends your prompts, attached media, and the notes and files accessed during a conversation to Google's Antigravity backend via the `agy` CLI. It never uploads your entire vault.
- **Backend binary**: If `agy` is not already installed, Anti-dian downloads and verifies the official Antigravity CLI binary from Google's release endpoint (or you can provide a local binary path in **Settings → Anti-dian → Advanced**).

## Development

See [ARCHITECTURE.md](./ARCHITECTURE.md) for how it works and how to build it, and [AGENTS.md](./AGENTS.md) for contributor guidelines.
