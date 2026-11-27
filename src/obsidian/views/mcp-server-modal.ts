import { App, Modal, Notice, Setting } from 'obsidian';
import {
	formatArgsLines,
	formatKeyValueLines,
	getMcpServerUrl,
	parseArgsLines,
	parseKeyValueLines,
	upsertMcpServer,
	type McpServerListItem,
	type McpServerType,
} from '../../core/models/mcp-config';

export interface McpServerModalOptions {
	existing?: McpServerListItem;
	onSaved: () => void;
}

export class McpServerModal extends Modal {
	private name: string;
	private type: McpServerType;
	private command: string;
	private argsText: string;
	private envText: string;
	private serverUrl: string;
	private headersText: string;
	private enabled: boolean;
	private readonly previousName?: string;
	private readonly onSaved: () => void;

	constructor(app: App, options: McpServerModalOptions) {
		super(app);
		const existing = options.existing;
		this.previousName = existing?.name;
		this.name = existing?.name ?? '';
		this.type = existing?.type ?? 'stdio';
		this.command = existing?.config.command ?? '';
		this.argsText = formatArgsLines(existing?.config.args);
		this.envText = formatKeyValueLines(existing?.config.env, '=');
		this.serverUrl = existing ? getMcpServerUrl(existing.config) : '';
		this.headersText = formatKeyValueLines(existing?.config.headers, ':');
		this.enabled = existing ? existing.enabled : true;
		this.onSaved = options.onSaved;
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();

		new Setting(contentEl)
			.setName(this.previousName ? 'Edit MCP server' : 'Add MCP server')
			.setHeading();

		new Setting(contentEl)
			.setName('Server name')
			.setDesc('Unique identifier used in mcp_config.json.')
			.addText((text) => {
				text
					.setPlaceholder('Excalidraw')
					.setValue(this.name)
					.onChange((val) => {
						this.name = val;
					});
			});

		new Setting(contentEl)
			.setName('Transport type')
			.setDesc('Choose stdio for local commands or HTTP for remote endpoints.')
			.addDropdown((dropdown) => {
				dropdown
					.addOption('stdio', 'Stdio (local command)')
					.addOption('http', 'HTTP (remote URL)')
					.setValue(this.type)
					.onChange((val) => {
						this.type = val as McpServerType;
						this.render();
					});
			});

		if (this.type === 'stdio') {
			new Setting(contentEl)
				.setName('Command')
				.setDesc('Executable to launch, such as node, npx, or python3.')
				.addText((text) => {
					text
						.setPlaceholder('Node')
						.setValue(this.command)
						.onChange((val) => {
							this.command = val;
						});
				});

			new Setting(contentEl)
				.setName('Arguments')
				.setDesc('One argument per line.')
				.addTextArea((area) => {
					area
						.setPlaceholder('/path/to/server.js')
						.setValue(this.argsText)
						.onChange((val) => {
							this.argsText = val;
						});
					area.inputEl.rows = 3;
				});

			new Setting(contentEl)
				.setName('Environment variables')
				.setDesc('Optional, one key=value pair per line.')
				.addTextArea((area) => {
					area
						.setPlaceholder('TOKEN=...')
						.setValue(this.envText)
						.onChange((val) => {
							this.envText = val;
						});
					area.inputEl.rows = 3;
				});
		} else {
			new Setting(contentEl)
				.setName('Server URL')
				.setDesc('Full HTTP or HTTPS endpoint URL.')
				.addText((text) => {
					text
						.setPlaceholder('https://api.example.com/mcp')
						.setValue(this.serverUrl)
						.onChange((val) => {
							this.serverUrl = val;
						});
				});

			new Setting(contentEl)
				.setName('HTTP headers')
				.setDesc('Optional, one name: value pair per line.')
				.addTextArea((area) => {
					area
						.setPlaceholder('Authorization: Bearer ...')
						.setValue(this.headersText)
						.onChange((val) => {
							this.headersText = val;
						});
					area.inputEl.rows = 3;
				});
		}

		new Setting(contentEl)
			.setName('Enabled')
			.setDesc('Include this server in new conversations.')
			.addToggle((toggle) => {
				toggle.setValue(this.enabled).onChange((val) => {
					this.enabled = val;
				});
			});

		new Setting(contentEl)
			.addButton((btn) => {
				btn.setButtonText('Cancel').onClick(() => this.close());
			})
			.addButton((btn) => {
				btn
					.setButtonText('Save')
					.setCta()
					.onClick(() => this.handleSave());
			});
	}

	private handleSave(): void {
		try {
			const env =
				this.type === 'stdio'
					? parseKeyValueLines(this.envText, '=')
					: undefined;
			const headers =
				this.type === 'http'
					? parseKeyValueLines(this.headersText, ':')
					: undefined;
			const args =
				this.type === 'stdio' ? parseArgsLines(this.argsText) : undefined;

			upsertMcpServer(
				this.name,
				{
					type: this.type,
					command: this.command,
					args,
					env,
					serverUrl: this.serverUrl,
					headers,
					enabled: this.enabled,
				},
				{ previousName: this.previousName },
			);

			new Notice(
				`Saved MCP server "${this.name.trim()}". Start a new conversation to apply.`,
			);
			this.onSaved();
			this.close();
		} catch (err) {
			new Notice(err instanceof Error ? err.message : String(err));
		}
	}
}
