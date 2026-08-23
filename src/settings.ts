import { App, PluginSettingTab, Setting } from 'obsidian';
import type AntiDianPlugin from './main';

export interface AntiDianSettings {
	apiKey?: string;
}

export const DEFAULT_SETTINGS: AntiDianSettings = {};

export class AntiDianSettingTab extends PluginSettingTab {
	plugin: AntiDianPlugin;

	constructor(app: App, plugin: AntiDianPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('API key')
			.setDesc('Gemini or model provider API key')
			.addText((text) =>
				text
					.setPlaceholder('Enter API key')
					.setValue(this.plugin.settings.apiKey ?? '')
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value.trim();
						await this.plugin.saveSettings();
					}),
			);
	}
}
