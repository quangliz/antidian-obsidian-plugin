import {
	App,
	ButtonComponent,
	DropdownComponent,
	Notice,
	PluginSettingTab,
	requireApiVersion,
	Setting,
	type SettingDefinitionItem,
} from 'obsidian';
import type AntidianPlugin from './main';
import {
	type ModelConfig,
	type CachedProviderMetadata,
	isAgyBinaryAvailable,
	resolveAgyBinary,
} from './core/models/antigravity-acp';
import {
	checkAndStageAgyUpdate,
	getManagedAgyBinaryPath,
	readValidBinarySidecar,
} from './core/models/agy-binary-manager';
import {
	getMcpConfigPath,
	listMcpServers,
	removeMcpServer,
	setMcpServerEnabled,
	type McpServerListItem,
} from './core/models/mcp-config';
import { discoverCompanionMcpServers } from './obsidian/adapters/companion-mcp';
import { McpServerModal } from './obsidian/views/mcp-server-modal';

export type PermissionMode = 'ask' | 'plan' | 'auto';

export interface AntidianSettings {
	model?: string;
	/** Thinking level to use with models that offer it. */
	thoughtLevel?: string;
	permissionMode?: PermissionMode;
	cliPath?: string;
	/** Optional PEM-encoded CA certificate path for corporate TLS/VPN proxies. */
	caCertificates?: string;
	/** Highlight pending write approvals inline in open Markdown editors. */
	enableInlineDiff?: boolean;
	/** Show raw tool arguments and output in the thinking trace (for debugging). */
	showRawToolData?: boolean;
	/** Persisted models/tier/quota snapshot for instant startup rendering. */
	cachedMetadata?: CachedProviderMetadata;
	/** Maps forked child session IDs to their parent session ID, label, and turn count. */
	sessionForks?: Record<
		string,
		{ parentId: string; title?: string; parentTurnCount?: number }
	>;
	/** Custom user-assigned conversation titles keyed by session ID. */
	sessionTitles?: Record<string, string>;
	/** Width in px of the conversation drawer, when the user resized it. */
	sessionDrawerWidth?: number;
	/** Pinned session IDs, in the order shown at the top of the conversation drawer. */
	pinnedSessions?: string[];
	/** Session IDs deleted by the user (filtered from the conversation list). */
	deletedSessions?: string[];
	/** Companion `*-antidian` plugin IDs whose auto-detected MCP server is disabled. */
	disabledCompanionMcps?: string[];
}

export const DEFAULT_SETTINGS: AntidianSettings = {
	model: '',
	permissionMode: 'ask',
	cliPath: '',
	caCertificates: '',
	enableInlineDiff: true,
	showRawToolData: false,
};

/** One settings row, rendered the same way by both settings APIs. */
interface SettingRow {
	name: string;
	desc: string;
	render: (setting: Setting) => void;
}

interface SettingGroupRows {
	heading: string;
	rows: SettingRow[];
}

export class AntidianSettingTab extends PluginSettingTab {
	plugin: AntidianPlugin;
	/** Rows currently on screen, updated by the live status check. */
	private authSetting: Setting | null = null;
	private authButton: ButtonComponent | null = null;
	private modelSetting: Setting | null = null;
	private modelDropdown: DropdownComponent | null = null;
	private signedIn = false;

	constructor(app: App, plugin: AntidianPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/** Obsidian 1.13+ renders the tab from these and lists them in settings search. */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return this.getGroups().map(({ heading, rows }) => ({ type: 'group', heading, items: rows }));
	}

	/** Obsidian before 1.13 calls this instead of getSettingDefinitions(). */
	display(): void {
		this.renderLegacy();
	}

	private renderLegacy(): void {
		const { containerEl } = this;
		containerEl.empty();
		for (const { heading, rows } of this.getGroups()) {
			new Setting(containerEl).setName(heading).setHeading();
			for (const row of rows) {
				row.render(new Setting(containerEl).setName(row.name).setDesc(row.desc));
			}
		}
	}

	private refresh(): void {
		if (requireApiVersion('1.13.0')) {
			this.update();
		} else {
			this.renderLegacy();
		}
	}

	private get cliFound(): boolean {
		return isAgyBinaryAvailable(this.plugin.settings.cliPath);
	}

	private get hasCustomPath(): boolean {
		return Boolean(this.plugin.settings.cliPath?.trim());
	}

	/** Must stay free of side effects: Obsidian also calls it to index the settings. */
	private getGroups(): SettingGroupRows[] {
		const { cliFound, hasCustomPath } = this;
		const resolvedBin = resolveAgyBinary(this.plugin.settings.cliPath);

		return [
			{
				heading: 'Account',
				rows: [
					{
						name: 'Google account',
						desc: cliFound
							? 'Checking sign-in status...'
							: hasCustomPath
								? `Configured binary not found: ${resolvedBin}`
								: 'Backend not installed yet. Click Sign in with Google to download and connect.',
						render: (setting) => this.renderAccount(setting),
					},
				],
			},
			{
				heading: 'Agent',
				rows: [
					{
						name: 'Default model',
						desc: 'Select the default model for reasoning and tool use.',
						render: (setting) => this.renderModel(setting),
					},
					{
						name: 'Permission mode',
						desc: 'Ask: free reads, writes require approval. Plan: read-only proposals. Auto: apply valid writes automatically.',
						render: (setting) => this.renderPermissionMode(setting),
					},
					{
						name: 'Inline editor diff',
						desc: 'Show pending write approvals directly inside open notes with accept and reject actions.',
						render: (setting) => this.renderInlineDiff(setting),
					},
					{
						name: 'Vault skills',
						desc: 'Add a folder with a SKILL.md file to .agents/skills/ to teach your own workflows. Type / in the prompt to run one.',
						render: (setting) => this.renderVaultSkills(setting),
					},
				],
			},
			{
				heading: 'MCP servers',
				rows: this.getMcpServerRows(),
			},
			{
				heading: 'Backend',
				rows: [
					{
						name: 'Antigravity backend',
						desc: cliFound
							? `Installed at ${resolvedBin}`
							: hasCustomPath
								? `Custom path not found: ${resolvedBin}`
								: `Not installed yet — will auto-download to ${getManagedAgyBinaryPath()}`,
						render: (setting) => this.renderBackend(setting),
					},
				],
			},
			{
				heading: 'Advanced',
				rows: [
					{
						name: 'Custom binary path',
						desc: `Optional override for the agy binary. Leave blank to auto-manage at ${getManagedAgyBinaryPath()}.`,
						render: (setting) => this.renderBinaryPath(setting),
					},
					{
						name: 'Custom root certificates',
						desc: 'Optional path to a certificate bundle trusted when downloading or running the backend behind a corporate proxy.',
						render: (setting) => this.renderCertificates(setting),
					},
					{
						name: 'Show raw tool data',
						desc: 'Include raw tool arguments and outputs in the thinking trace for debugging.',
						render: (setting) => this.renderRawToolData(setting),
					},
				],
			},
		];
	}

	private renderAccount(setting: Setting): void {
		this.authSetting = setting;
		this.signedIn = false;
		setting.addButton((button) => {
			this.authButton = button;
			button
				.setButtonText('Sign in with Google')
				.setCta()
				.setDisabled(this.hasCustomPath && !this.cliFound)
				.onClick(async () => {
					button.setDisabled(true);
					button.setButtonText('Preparing...');
					try {
						await this.plugin.antigravityProvider.login((progress) => {
							button.setButtonText(
								progress.percent !== undefined
									? `Downloading (${progress.percent}%)...`
									: progress.message,
							);
							setting.setDesc(progress.message);
						}, this.signedIn);
						new Notice('Sign-in successful.');
						this.refresh();
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						new Notice(`Login failed: ${message}`);
						setting.setDesc(`Not signed in (${message})`);
						this.signedIn = false;
						button.setDisabled(false);
						button.setButtonText('Sign in with Google');
						button.setTooltip('');
						button.setCta();
					}
				});
		});
		if (this.cliFound) void this.refreshLiveStatus(setting);
	}

	private renderModel(setting: Setting): void {
		this.modelSetting = setting;
		this.modelDropdown = null;
		// Hydrate immediately from persisted/in-memory cache (0 ms)
		const cachedConfig = this.plugin.antigravityProvider.getModelConfig();
		if (cachedConfig) {
			this.populateModelDropdown(cachedConfig);
		} else if (this.cliFound) {
			setting.setDesc('Loading available models...');
		} else if (this.hasCustomPath) {
			setting.setDesc('Configure a valid binary path to load models.');
		} else {
			setting.setDesc('Sign in with Google to install the backend and load models.');
		}
	}

	private populateModelDropdown(config: ModelConfig): void {
		if (!this.modelDropdown) {
			this.modelSetting?.addDropdown((dropdown) => {
				this.modelDropdown = dropdown;
				dropdown.onChange(async (val) => {
					this.plugin.settings.model = val;
					await this.plugin.saveSettings();
				});
			});
		}
		const dd = this.modelDropdown;
		if (!dd) return;
		dd.selectEl.empty();
		for (const option of config.model.options) {
			dd.addOption(option.value, option.name);
		}
		dd.setValue(config.model.current);
	}

	private renderPermissionMode(setting: Setting): void {
		setting.addDropdown((dropdown) => {
			dropdown
				.addOption('ask', 'Ask (approval required)')
				.addOption('plan', 'Plan (read-only proposals)')
				.addOption('auto', 'Auto (auto-apply valid writes)')
				.setValue(this.plugin.settings.permissionMode ?? 'ask')
				.onChange(async (val) => {
					this.plugin.settings.permissionMode = val as PermissionMode;
					await this.plugin.saveSettings();
				});
		});
	}

	private renderInlineDiff(setting: Setting): void {
		setting.addToggle((toggle) => {
			toggle
				.setValue(this.plugin.settings.enableInlineDiff ?? true)
				.onChange(async (value) => {
					this.plugin.settings.enableInlineDiff = value;
					if (!value) {
						this.plugin.inlineDiffController.clearAll();
					}
					await this.plugin.saveSettings();
				});
		});
	}

	private renderVaultSkills(setting: Setting): void {
		void this.app.vault.adapter.exists('.anti-dian/skills').then((legacy) => {
			if (!legacy) return;
			setting.setDesc(
				'Skills in .anti-dian/skills/ are no longer loaded. Move each one to .agents/skills/<name>/SKILL.md.',
			);
		});
	}

	private getMcpServerRows(): SettingRow[] {
		const configPath = getMcpConfigPath();
		const rows: SettingRow[] = [
			{
				name: 'Configured servers',
				desc: `Shared with Antigravity CLI (${configPath}). Changes apply to new conversations.`,
				render: (setting) => {
					setting.addButton((button) => {
						button
							.setButtonText('Add server')
							.setCta()
							.onClick(() => {
								new McpServerModal(this.app, {
									onSaved: () => this.refresh(),
								}).open();
							});
					});
					setting.addExtraButton((button) => {
						button
							.setIcon('refresh-cw')
							.setTooltip('Reload configuration')
							.onClick(() => this.refresh());
					});
				},
			},
		];

		let servers: McpServerListItem[] = [];
		let configReadError: string | null = null;
		try {
			servers = listMcpServers(configPath);
		} catch (err) {
			configReadError = err instanceof Error ? err.message : String(err);
		}

		if (configReadError) {
			rows.push({
				name: 'Configuration error',
				desc: `Could not read ${configPath}: ${configReadError}`,
				render: () => {},
			});
		} else if (servers.length === 0) {
			rows.push({
				name: 'No MCP servers configured',
				desc: 'Click Add server to connect a local stdio or remote HTTP MCP server.',
				render: () => {},
			});
		} else {
			for (const item of servers) {
				rows.push({
					name: item.name,
					desc: `${item.type} · ${item.summary}`,
					render: (setting) => this.renderMcpServerRow(setting, item),
				});
			}
		}

		const companions = discoverCompanionMcpServers(this.app);
		const disabledSet = new Set(this.plugin.settings.disabledCompanionMcps ?? []);
		if (companions.length === 0) {
			rows.push({
				name: 'No companion plugins detected',
				desc: 'Enabled Obsidian plugins ending with -antidian that expose getAntidianMcpServer() appear here automatically.',
				render: () => {},
			});
		} else {
			for (const companion of companions) {
				const enabled = !disabledSet.has(companion.pluginId);
				rows.push({
					name: `${companion.pluginName} (${companion.serverName})`,
					desc: `http · ${companion.url} · auto-detected (${companion.pluginId})`,
					render: (setting) => {
						setting.addToggle((toggle) => {
							toggle.setValue(enabled).onChange(async (nextEnabled) => {
								const nextDisabled = new Set(
									this.plugin.settings.disabledCompanionMcps ?? [],
								);
								if (nextEnabled) {
									nextDisabled.delete(companion.pluginId);
								} else {
									nextDisabled.add(companion.pluginId);
								}
								this.plugin.settings.disabledCompanionMcps = Array.from(nextDisabled);
								await this.plugin.saveSettings();
								new Notice(
									`Companion MCP "${companion.serverName}" ${nextEnabled ? 'enabled' : 'disabled'}. Start a new conversation to apply.`,
								);
							});
						});
					},
				});
			}
		}
		return rows;
	}

	private renderMcpServerRow(setting: Setting, item: McpServerListItem): void {
		setting.addToggle((toggle) => {
			toggle.setValue(item.enabled).onChange((enabled) => {
				try {
					setMcpServerEnabled(item.name, enabled);
					new Notice(
						`MCP server "${item.name}" ${enabled ? 'enabled' : 'disabled'}. Start a new conversation to apply.`,
					);
				} catch (err) {
					new Notice(err instanceof Error ? err.message : String(err));
					toggle.setValue(!enabled);
				}
			});
		});
		setting.addExtraButton((button) => {
			button
				.setIcon('pencil')
				.setTooltip(`Edit ${item.name}`)
				.onClick(() => {
					new McpServerModal(this.app, {
						existing: item,
						onSaved: () => this.refresh(),
					}).open();
				});
		});
		setting.addExtraButton((button) => {
			button
				.setIcon('trash')
				.setTooltip(`Remove ${item.name}`)
				.onClick(() => {
					try {
						removeMcpServer(item.name);
						new Notice(
							`Removed MCP server "${item.name}". Start a new conversation to apply.`,
						);
						this.refresh();
					} catch (err) {
						new Notice(err instanceof Error ? err.message : String(err));
					}
				});
		});
	}

	private renderBackend(setting: Setting): void {
		const { cliFound, hasCustomPath } = this;
		if (hasCustomPath) return;
		if (cliFound) {
			const resolvedBin = resolveAgyBinary(this.plugin.settings.cliPath);
			void readValidBinarySidecar(resolvedBin).then((sidecar) => {
				const ver = sidecar?.version ? `v${sidecar.version}` : 'installed';
				const stagedNote = sidecar?.stagedNext
					? ` · v${sidecar.stagedNext.version} staged for next restart`
					: '';
				setting.setDesc(`${ver} (${resolvedBin})${stagedNote}`);
			});
		}

		setting.addButton((button) => {
			button
				.setButtonText(cliFound ? 'Check for updates' : 'Install backend')
				.onClick(async () => {
					button.setDisabled(true);
					button.setButtonText('Checking...');
					try {
						if (!isAgyBinaryAvailable()) {
							const res = await this.plugin.antigravityProvider.ensureBinary(
								(progress) => {
									setting.setDesc(progress.message);
								},
							);
							new Notice(`Installed backend${res.version ? ` v${res.version}` : ''}.`);
							this.refresh();
							return;
						}
						const res = await checkAndStageAgyUpdate({
							caCertificates: this.plugin.settings.caCertificates,
							force: true,
							onProgress: (progress) => {
								setting.setDesc(progress.message);
							},
						});
						if (res.status === 'installed') {
							new Notice(`Updated backend to v${res.version ?? 'latest'}.`);
							this.refresh();
						} else if (res.status === 'staged') {
							new Notice(
								`Downloaded v${res.version ?? 'latest'}; it will apply on next restart.`,
							);
							this.refresh();
						} else if (res.status === 'up_to_date') {
							new Notice('Backend is already up to date.');
						} else if (res.status === 'error') {
							new Notice(`Update check failed: ${res.error ?? 'unknown error'}`);
						}
					} catch (err) {
						new Notice(
							`Update failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					} finally {
						button.setDisabled(false);
						button.setButtonText(
							isAgyBinaryAvailable() ? 'Check for updates' : 'Install backend',
						);
					}
				});
		});
	}

	private renderBinaryPath(setting: Setting): void {
		setting.addText((text) => {
			text.setPlaceholder(getManagedAgyBinaryPath()).setValue(
				this.plugin.settings.cliPath ?? '',
			);
			text.inputEl.addEventListener('blur', () => {
				const next = text.getValue().trim();
				if (next !== (this.plugin.settings.cliPath ?? '')) {
					this.plugin.settings.cliPath = next;
					void this.plugin.saveSettings().then(() => this.refresh());
				}
			});
		});
	}

	private renderCertificates(setting: Setting): void {
		setting.addText((text) => {
			text.setPlaceholder('/path/to/corporate-ca.pem').setValue(
				this.plugin.settings.caCertificates ?? '',
			);
			text.inputEl.addEventListener('blur', () => {
				const next = text.getValue().trim();
				if (next !== (this.plugin.settings.caCertificates ?? '')) {
					this.plugin.settings.caCertificates = next;
					void this.plugin.saveSettings();
				}
			});
		});
	}

	private renderRawToolData(setting: Setting): void {
		setting.addToggle((toggle) => {
			toggle
				.setValue(this.plugin.settings.showRawToolData ?? false)
				.onChange(async (value) => {
					this.plugin.settings.showRawToolData = value;
					await this.plugin.saveSettings();
				});
		});
	}

	/** Live sign-in status & model refresh, shown on the account and model rows. */
	private async refreshLiveStatus(authSetting: Setting): Promise<void> {
		const button = this.authButton;
		try {
			const status = await this.plugin.antigravityProvider.checkStatus((progress) => {
				authSetting.setDesc(progress.message);
			});
			// The tab was rendered again meanwhile; that render runs its own check.
			if (this.authSetting !== authSetting || this.authButton !== button) return;

			if (!status.cliFound) {
				authSetting.setDesc(`Could not prepare backend: ${status.error ?? 'unknown error'}`);
				if (!this.modelDropdown) {
					this.modelSetting?.setDesc('Backend is required to load available models.');
				}
				return;
			}

			if (!status.authenticated) {
				authSetting.setDesc(
					`Not signed in (${status.error ?? 'click Sign in with Google'})`,
				);
				if (!this.modelDropdown) {
					this.modelSetting?.setDesc('Sign in with Google to load available models.');
				}
				return;
			}

			const tierLabel = status.tier?.tierName ? ` · ${status.tier.tierName}` : '';
			authSetting.setDesc(`Connected${tierLabel}`);
			this.signedIn = true;
			button
				?.setButtonText('Re-authenticate')
				.setTooltip(
					'Signs out of this account, which the agy CLI may share, then signs in again',
				)
				.removeCta();

			const config = await this.plugin.antigravityProvider.fetchModelConfig();
			if (this.authButton !== button) return;
			this.modelSetting?.setDesc('Select the default model for reasoning and tool use.');
			if (config) this.populateModelDropdown(config);
		} catch (err) {
			if (this.authButton === button && !this.modelDropdown) {
				this.modelSetting?.setDesc(
					`Could not load models: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}
}
