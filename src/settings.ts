import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type AntiDianPlugin from './main';
import {
	formatTokens,
	isAgyBinaryAvailable,
	resolveAgyBinary,
} from './core/models/antigravity-acp';

export type PermissionMode = 'ask' | 'plan' | 'auto';

export interface AntiDianSettings {
	model?: string;
	permissionMode?: PermissionMode;
	cliPath?: string;
	/** Show raw tool arguments and output in the thinking trace (for debugging). */
	showRawToolData?: boolean;
}

export const DEFAULT_SETTINGS: AntiDianSettings = {
	model: '',
	permissionMode: 'ask',
	cliPath: '',
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

		const authSetting = new Setting(containerEl)
			.setName('Antigravity CLI authentication')
			.setDesc(
				cliFound
					? `Checking official Antigravity CLI (${resolvedBin})...`
					: 'Antigravity CLI (agy) not found. Install it or set its path below.',
			);

		authSetting.addButton((button) => {
			button
				.setButtonText('Sign in with Google')
				.setCta()
				.setDisabled(!cliFound)
				.onClick(async () => {
					button.setDisabled(true);
					button.setButtonText('Waiting for browser...');
					try {
						await this.plugin.antigravityProvider.login();
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
				'Optional path to the official agy binary. Leave blank to auto-detect from path or ~/.local/bin/agy.',
			)
			.addText((text) => {
				text.setPlaceholder('/usr/local/bin/agy')
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

		if (cliFound) {
			const modelSetting = new Setting(containerEl)
				.setName('Model')
				.setDesc('Loading available models from antigravity CLI...');

			void this.plugin.antigravityProvider
				.checkStatus()
				.then(async (status) => {
					if (status.authenticated) {
						const tierLabel = status.tier?.tierName
							? ` (${status.tier.tierName})`
							: '';
						authSetting.setDesc(
							`Connected via official Antigravity CLI (${resolvedBin})${tierLabel}`,
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
							'Sign in with antigravity CLI to load available models.',
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
