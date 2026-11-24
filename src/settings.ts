import {
	App,
	ButtonComponent,
	DropdownComponent,
	Notice,
	PluginSettingTab,
	Setting,
} from 'obsidian';
import type AntiDianPlugin from './main';
import {
	type AvailableModel,
	type CachedProviderMetadata,
	formatTokens,
	isAgyBinaryAvailable,
	resolveAgyBinary,
} from './core/models/antigravity-acp';
import {
	checkAndStageAgyUpdate,
	getManagedAgyBinaryPath,
	readValidBinarySidecar,
} from './core/models/agy-binary-manager';

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
	/** Maps forked child session IDs to their parent session ID and fallback label. */
	sessionForks?: Record<string, { parentId: string; title?: string }>;
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

		/* ── Account ──────────────────────────────────────────────────────── */
		new Setting(containerEl).setName('Account').setHeading();

		let authButton: ButtonComponent | null = null;
		const authSetting = new Setting(containerEl)
			.setName('Google account')
			.setDesc(
				cliFound
					? 'Checking sign-in status...'
					: hasCustomPath
						? `Configured binary not found: ${resolvedBin}`
						: 'Preparing backend (will download automatically if needed)...',
			);

		authSetting.addButton((button) => {
			authButton = button;
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
						new Notice('Sign-in successful.');
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

		/* ── Agent ────────────────────────────────────────────────────────── */
		new Setting(containerEl).setName('Agent').setHeading();

		const modelSetting = new Setting(containerEl)
			.setName('Default model')
			.setDesc('Select the default model for reasoning and tool use.');

		let modelDropdown: DropdownComponent | null = null;
		const populateModelDropdown = (
			models: AvailableModel[],
			defaultModelId?: string,
		): void => {
			if (models.length === 0) return;
			if (!modelDropdown) {
				modelSetting.addDropdown((dropdown) => {
					modelDropdown = dropdown;
					dropdown.onChange(async (val) => {
						this.plugin.settings.model = val;
						this.plugin.antigravityProvider.setModel(val);
						await this.plugin.saveSettings();
					});
				});
			}
			const dd = modelDropdown;
			if (!dd) return;
			dd.selectEl.empty();
			for (const m of models) {
				const ctxLabel = m.maxTokens ? ` (${formatTokens(m.maxTokens)} ctx)` : '';
				dd.addOption(m.id, `${m.displayName}${ctxLabel}`);
			}
			const currentModel =
				this.plugin.settings.model || defaultModelId || models[0]?.id || '';
			if (currentModel) {
				dd.setValue(currentModel);
			}
		};

		// Hydrate immediately from persisted/in-memory cache (0 ms)
		const cachedModels =
			this.plugin.antigravityProvider.getCachedAvailableModels();
		if (cachedModels && cachedModels.models.length > 0) {
			populateModelDropdown(cachedModels.models, cachedModels.defaultModelId);
		} else if (!hasCustomPath || cliFound) {
			modelSetting.setDesc('Loading available models...');
		} else {
			modelSetting.setDesc('Configure a valid binary path to load models.');
		}

		new Setting(containerEl)
			.setName('Permission mode')
			.setDesc(
				'Ask: free reads, writes require approval. Plan: read-only proposals. Auto: apply valid writes automatically.',
			)
			.addDropdown((dropdown) => {
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

		const skillsSetting = new Setting(containerEl)
			.setName('Vault skills')
			.setDesc('Checking .anti-dian/skills/...');

		void this.plugin.skillAdapter
			.listSkills()
			.then((skills) => {
				if (skills.length === 0) {
					skillsSetting.setDesc(
						'No skills configured. Add Markdown skill files to .anti-dian/skills/ to extend workflows.',
					);
				} else {
					const names = skills
						.slice(0, 5)
						.map((s) => s.name)
						.join(', ');
					const more =
						skills.length > 5 ? ` (+${skills.length - 5} more)` : '';
					skillsSetting.setDesc(
						`${skills.length} skill${skills.length === 1 ? '' : 's'} loaded from .anti-dian/skills/: ${names}${more}`,
					);
				}
			})
			.catch(() => {
				skillsSetting.setDesc('Could not read .anti-dian/skills/.');
			});

		/* ── Backend ──────────────────────────────────────────────────────── */
		new Setting(containerEl).setName('Backend').setHeading();

		const backendSetting = new Setting(containerEl)
			.setName('Antigravity backend')
			.setDesc(
				cliFound
					? `Installed at ${resolvedBin}`
					: hasCustomPath
						? `Custom path not found: ${resolvedBin}`
						: `Not installed yet — will auto-download to ${getManagedAgyBinaryPath()}`,
			);

		if (cliFound && !hasCustomPath) {
			void readValidBinarySidecar(resolvedBin).then((sidecar) => {
				const ver = sidecar?.version ? `v${sidecar.version}` : 'installed';
				const stagedNote = sidecar?.stagedNext
					? ` · v${sidecar.stagedNext.version} staged for next restart`
					: '';
				backendSetting.setDesc(`${ver} (${resolvedBin})${stagedNote}`);
			});
		}

		if (!hasCustomPath) {
			backendSetting.addButton((button) => {
				button
					.setButtonText('Check for updates')
					.onClick(async () => {
						button.setDisabled(true);
						button.setButtonText('Checking...');
						try {
							if (!isAgyBinaryAvailable()) {
								const res =
									await this.plugin.antigravityProvider.ensureBinary(
										(progress) => {
											backendSetting.setDesc(progress.message);
										},
									);
								new Notice(
									`Installed backend${res.version ? ` v${res.version}` : ''}.`,
								);
								this.display();
								return;
							}
							const res = await checkAndStageAgyUpdate({
								caCertificates: this.plugin.settings.caCertificates,
								force: true,
								onProgress: (progress) => {
									backendSetting.setDesc(progress.message);
								},
							});
							if (res.status === 'installed') {
								new Notice(
									`Updated backend to v${res.version ?? 'latest'}.`,
								);
								this.display();
							} else if (res.status === 'staged') {
								new Notice(
									`Downloaded v${res.version ?? 'latest'}; it will apply on next restart.`,
								);
								this.display();
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
							button.setButtonText('Check for updates');
						}
					});
			});
		}

		/* ── Advanced ─────────────────────────────────────────────────────── */
		new Setting(containerEl).setName('Advanced').setHeading();

		new Setting(containerEl)
			.setName('Custom binary path')
			.setDesc(
				`Optional override for the agy binary. Leave blank to auto-manage at ${getManagedAgyBinaryPath()}.`,
			)
			.addText((text) => {
				text.setPlaceholder(getManagedAgyBinaryPath()).setValue(
					this.plugin.settings.cliPath ?? '',
				);
				text.inputEl.addEventListener('blur', () => {
					const next = text.getValue().trim();
					if (next !== (this.plugin.settings.cliPath ?? '')) {
						this.plugin.settings.cliPath = next;
						void this.plugin.saveSettings().then(() => this.display());
					}
				});
			});

		new Setting(containerEl)
			.setName('Custom root certificates')
			.setDesc(
				'Optional path to a certificate bundle trusted when downloading or running the backend behind a corporate proxy.',
			)
			.addText((text) => {
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

		new Setting(containerEl)
			.setName('Show raw tool data')
			.setDesc(
				'Include raw tool arguments and outputs in the thinking trace for debugging.',
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.showRawToolData ?? false)
					.onChange(async (value) => {
						this.plugin.settings.showRawToolData = value;
						await this.plugin.saveSettings();
					});
			});

		/* ── Live status & model refresh ──────────────────────────────────── */
		if (!hasCustomPath || cliFound) {
			void this.plugin.antigravityProvider
				.checkStatus((progress) => {
					authSetting.setDesc(progress.message);
				})
				.then(async (status) => {
					if (!status.cliFound) {
						authSetting.setDesc(
							`Could not prepare backend: ${status.error ?? 'unknown error'}`,
						);
						if (!modelDropdown) {
							modelSetting.setDesc(
								'Backend is required to load available models.',
							);
						}
						return;
					}

					if (status.authenticated) {
						const tierLabel = status.tier?.tierName
							? ` · ${status.tier.tierName}`
							: '';
						authSetting.setDesc(`Connected${tierLabel}`);
						if (authButton) {
							authButton.setButtonText('Re-authenticate');
							authButton.removeCta();
						}

						const { models, defaultModelId } =
							await this.plugin.antigravityProvider.fetchAvailableModels();
						modelSetting.setDesc(
							'Select the default model for reasoning and tool use.',
						);
						populateModelDropdown(models, defaultModelId);
					} else {
						authSetting.setDesc(
							`Not signed in (${status.error ?? 'click Sign in with Google'})`,
						);
						if (!modelDropdown) {
							modelSetting.setDesc(
								'Sign in with Google to load available models.',
							);
						}
					}
				})
				.catch((err) => {
					if (!modelDropdown) {
						modelSetting.setDesc(
							`Could not load models: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				});
		}
	}
}
