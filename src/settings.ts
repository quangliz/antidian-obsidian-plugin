import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type AntiDianPlugin from './main';
import {
	type CachedProviderMetadata,
	formatTokens,
	isAgyBinaryAvailable,
	resolveAgyBinary,
} from './core/models/antigravity-acp';
import { getManagedAgyBinaryPath } from './core/models/agy-binary-manager';

export type PermissionMode = 'ask' | 'plan' | 'auto';

export interface AntiDianSettings {
	model?: string;
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
}

export const DEFAULT_SETTINGS: AntiDianSettings = {
	model: '',
	permissionMode: 'ask',
	cliPath: '',
	caCertificates: '',
	enableInlineDiff: true,
	showRawToolData: false,
};

export class AntiDianSettingTab extends PluginSettingTab {
	plugin: AntiDianPlugin;

	constructor(app: App, plugin: AntiDianPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const cliFound = isAgyBinaryAvailable(this.plugin.settings.cliPath);
		const resolvedBin = resolveAgyBinary(this.plugin.settings.cliPath);
		const hasCustomPath = Boolean(this.plugin.settings.cliPath?.trim());

		const authSetting = new Setting(containerEl)
			.setName('Antigravity authentication')
			.setDesc(
				cliFound
					? `Checking Antigravity backend (${resolvedBin})...`
					: hasCustomPath
						? `Configured path not found: ${resolvedBin}`
						: 'Preparing Antigravity backend (will download automatically if needed)...',
			);

		authSetting.addButton((button) => {
			button
				.setButtonText('Sign in with Google')
				.setCta()
				.setDisabled(hasCustomPath && !cliFound)
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
							authSetting.setDesc(progress.message);
						});
						button.setButtonText('Waiting for browser...');
						new Notice('Antigravity login successful');
						this.display();
					} catch (err) {
						new Notice(
							`Login failed: ${err instanceof Error ? err.message : String(err)}`,
						);
						button.setDisabled(false);
						button.setButtonText('Sign in with Google');
					}
				});
		});

		new Setting(containerEl)
			.setName('Antigravity CLI path')
			.setDesc(
				`Optional custom path to the agy binary. Leave blank to auto-download and manage it at ${getManagedAgyBinaryPath()} (shared with the Antigravity VS Code extension).`,
			)
			.addText((text) => {
				text.setPlaceholder(getManagedAgyBinaryPath())
					.setValue(this.plugin.settings.cliPath ?? '')
					.onChange(async (value) => {
						this.plugin.settings.cliPath = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Permission mode')
			.setDesc(
				'Ask: Free read, writes require approval. Plan: Read-only proposals. Auto: Auto-apply valid mutations.',
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOption('ask', 'Ask (approval required)')
					.addOption('plan', 'Plan (read-only proposals)')
					.addOption('auto', 'Auto (auto-apply valid writes)')
					.setValue(this.plugin.settings.permissionMode ?? 'ask')
					.onChange(async (val) => {
						this.plugin.settings.permissionMode =
							val as PermissionMode;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Inline editor diff')
			.setDesc(
				'Show pending write approvals directly inside open notes with accept and reject actions.',
			)
			.addToggle((toggle) => {
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

		new Setting(containerEl)
			.setName('Custom root certificates')
			.setDesc(
				'Optional path to a certificate bundle trusted when downloading or running the antigravity backend behind a corporate proxy.',
			)
			.addText((text) => {
				text.setPlaceholder('/path/to/corporate-ca.pem')
					.setValue(this.plugin.settings.caCertificates ?? '')
					.onChange(async (value) => {
						this.plugin.settings.caCertificates = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Show raw tool data')
			.setDesc(
				'Add the raw arguments and output of each tool call to its details in the thinking trace. Useful for debugging.',
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.showRawToolData ?? false)
					.onChange(async (value) => {
						this.plugin.settings.showRawToolData = value;
						await this.plugin.saveSettings();
					});
			});

		if (!hasCustomPath || cliFound) {
			const modelSetting = new Setting(containerEl)
				.setName('Model')
				.setDesc('Loading available models from antigravity...');

			void this.plugin.antigravityProvider
				.checkStatus((progress) => {
					authSetting.setDesc(progress.message);
				})
				.then(async (status) => {
					const activeBin = status.binaryPath ?? resolvedBin;
					if (!status.cliFound) {
						authSetting.setDesc(
							`Could not prepare Antigravity backend: ${status.error ?? 'unknown error'}`,
						);
						modelSetting.setDesc(
							'Antigravity backend is required to load available models.',
						);
						return;
					}

					if (status.authenticated) {
						const tierLabel = status.tier?.tierName
							? ` (${status.tier.tierName})`
							: '';
						authSetting.setDesc(
							`Connected via Antigravity backend (${activeBin})${tierLabel}`,
						);

						const { models, defaultModelId } =
							await this.plugin.antigravityProvider.fetchAvailableModels();
						modelSetting.setDesc(
							'Select active model for reasoning and tool use.',
						);
						modelSetting.addDropdown((dropdown) => {
							for (const m of models) {
								const ctxLabel = m.maxTokens
									? ` (${formatTokens(m.maxTokens)} ctx)`
									: '';
								dropdown.addOption(
									m.id,
									`${m.displayName}${ctxLabel}`,
								);
							}

							const currentModel =
								this.plugin.settings.model ||
								defaultModelId ||
								models[0]?.id ||
								'';
							if (currentModel) {
								dropdown.setValue(currentModel);
							}

							dropdown.onChange(async (val) => {
								this.plugin.settings.model = val;
								this.plugin.antigravityProvider.setModel(val);
								await this.plugin.saveSettings();
							});
						});
					} else {
						authSetting.setDesc(
							`Not signed in (${status.error ?? 'click Sign in with Google'})`,
						);
						modelSetting.setDesc(
							'Sign in with Google to load available models.',
						);
					}
				})
				.catch((err) => {
					modelSetting.setDesc(
						`Could not load models: ${err instanceof Error ? err.message : String(err)}`,
					);
				});
		}
	}
}
