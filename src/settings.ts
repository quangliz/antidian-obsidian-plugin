import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type AntiDianPlugin from './main';
import {
	isLoggedIn,
	startOAuthLogin,
	fetchAvailableModels,
	formatTokens,
} from './core/antigravity-oauth';

export interface AntiDianSettings {
	model?: string;
}

export const DEFAULT_SETTINGS: AntiDianSettings = {
	model: 'gemini-3.7-flash-high',
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

		const loggedIn = isLoggedIn();

		new Setting(containerEl)
			.setName('Google antigravity authentication')
			.setDesc(
				loggedIn
					? 'Connected via Google Antigravity OAuth (~/.config/antigravity-oauth/tokens.json)'
					: 'Not connected. Connect using your Google account.',
			)
			.addButton((button) => {
				button
					.setButtonText(
						loggedIn ? 'Re-authenticate' : 'Connect with Google',
					)
					.setCta()
					.onClick(async () => {
						button.setDisabled(true);
						button.setButtonText('Waiting for browser...');
						try {
							await startOAuthLogin();
							new Notice('Antigravity login successful');
							this.display();
						} catch (err) {
							new Notice(
								`Login failed: ${err instanceof Error ? err.message : String(err)}`,
							);
							button.setDisabled(false);
							button.setButtonText('Connect with Google');
						}
					});
			});

		if (loggedIn) {
			const modelSetting = new Setting(containerEl)
				.setName('Model')
				.setDesc('Loading available models from API...');

			void fetchAvailableModels()
				.then(({ models, defaultModelId }) => {
					modelSetting.setDesc('Select active model for reasoning and tool use.');
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
							'gemini-3.7-flash-high';
						dropdown.setValue(currentModel);

						dropdown.onChange(async (val) => {
							this.plugin.settings.model = val;
							this.plugin.geminiProvider.setModel(val);
							await this.plugin.saveSettings();
						});
					});
				})
				.catch((err) => {
					modelSetting.setDesc(
						`Could not load models via API: ${err instanceof Error ? err.message : String(err)}`,
					);
				});
		}
	}
}
