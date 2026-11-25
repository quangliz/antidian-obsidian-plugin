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

export type PermissionMode = 'ask' | 'plan' | 'auto';

export interface AntiDianSettings {
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
		let signedIn = false;
		const authSetting = new Setting(containerEl)
			.setName('Google account')
			.setDesc(
				cliFound
					? 'Checking sign-in status...'
					: hasCustomPath
						? `Configured binary not found: ${resolvedBin}`
						: 'Backend not installed yet. Click Sign in with Google to download and connect.',
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
						}, signedIn);
						new Notice('Sign-in successful.');
						this.display();
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						new Notice(`Login failed: ${message}`);
						authSetting.setDesc(`Not signed in (${message})`);
						signedIn = false;
						button.setDisabled(false);
						button.setButtonText('Sign in with Google');
						button.setTooltip('');
						button.setCta();
					}
				});
		});

		/* ── Agent ────────────────────────────────────────────────────────── */
		new Setting(containerEl).setName('Agent').setHeading();

		const modelSetting = new Setting(containerEl)
			.setName('Default model')
			.setDesc('Select the default model for reasoning and tool use.');

		let modelDropdown: DropdownComponent | null = null;
		const populateModelDropdown = (config: ModelConfig): void => {
			if (!modelDropdown) {
				modelSetting.addDropdown((dropdown) => {
					modelDropdown = dropdown;
					dropdown.onChange(async (val) => {
						this.plugin.settings.model = val;
						await this.plugin.saveSettings();
					});
				});
			}
			const dd = modelDropdown;
			if (!dd) return;
			dd.selectEl.empty();
			for (const option of config.model.options) {
				dd.addOption(option.value, option.name);
			}
			dd.setValue(config.model.current);
		};

		// Hydrate immediately from persisted/in-memory cache (0 ms)
		const cachedConfig = this.plugin.antigravityProvider.getModelConfig();
		if (cachedConfig) {
			populateModelDropdown(cachedConfig);
		} else if (cliFound) {
			modelSetting.setDesc('Loading available models...');
		} else if (hasCustomPath) {
			modelSetting.setDesc('Configure a valid binary path to load models.');
		} else {
			modelSetting.setDesc('Sign in with Google to install the backend and load models.');
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
			.setDesc(
				'Add a folder with a SKILL.md file to .agents/skills/ to teach your own workflows. Type / in the prompt to run one.',
			);
		void this.app.vault.adapter.exists('.anti-dian/skills').then((legacy) => {
			if (!legacy) return;
			skillsSetting.setDesc(
				'Skills in .anti-dian/skills/ are no longer loaded. Move each one to .agents/skills/<name>/SKILL.md.',
			);
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
					.setButtonText(cliFound ? 'Check for updates' : 'Install backend')
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
							button.setButtonText(
								isAgyBinaryAvailable() ? 'Check for updates' : 'Install backend',
							);
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
		if (cliFound) {
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
						signedIn = true;
						if (authButton) {
							authButton.setButtonText('Re-authenticate');
							authButton.setTooltip(
								'Signs out of this account, which the agy CLI may share, then signs in again',
							);
							authButton.removeCta();
						}

						const config =
							await this.plugin.antigravityProvider.fetchModelConfig();
						modelSetting.setDesc(
							'Select the default model for reasoning and tool use.',
						);
						if (config) populateModelDropdown(config);
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
