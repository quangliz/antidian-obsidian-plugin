import { Plugin, WorkspaceLeaf } from 'obsidian';
import {
	DEFAULT_SETTINGS,
	AntiDianSettings,
	AntiDianSettingTab,
} from './settings';
import {
	ANTI_DIAN_VIEW_TYPE,
	AntiDianSidebarView,
} from './obsidian/sidebar-view';
import { ObsidianContextService } from './obsidian/context-service';
import { ObsidianVaultService } from './obsidian/vault-service';
import { GeminiProvider } from './core/gemini-provider';
import { createVaultTools } from './core/tools';
import { Agent } from './core/agent';

export default class AntiDianPlugin extends Plugin {
	settings!: AntiDianSettings;
	contextService!: ObsidianContextService;
	vaultService!: ObsidianVaultService;
	geminiProvider!: GeminiProvider;
	agent!: Agent;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.contextService = new ObsidianContextService(this.app);
		this.vaultService = new ObsidianVaultService(this.app);
		this.geminiProvider = new GeminiProvider({
			model: this.settings.model,
		});

		const tools = createVaultTools(this.vaultService);
		this.agent = new Agent({
			provider: this.geminiProvider,
			tools,
		});

		this.registerView(
			ANTI_DIAN_VIEW_TYPE,
			(leaf: WorkspaceLeaf) =>
				new AntiDianSidebarView(leaf, this.contextService, this.agent),
		);

		this.addRibbonIcon('bot', 'Open anti-dian', () => {
			void this.activateView();
		});

		this.addCommand({
			id: 'open-sidebar',
			name: 'Open sidebar',
			callback: () => {
				void this.activateView();
			},
		});

		this.addSettingTab(new AntiDianSettingTab(this.app, this));
	}

	onunload(): void {
		this.contextService?.destroy();
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(ANTI_DIAN_VIEW_TYPE)[0];

		if (!leaf) {
			const rightLeaf = workspace.getRightLeaf(false);
			if (rightLeaf) {
				await rightLeaf.setViewState({
					type: ANTI_DIAN_VIEW_TYPE,
					active: true,
				});
				leaf = rightLeaf;
			}
		}

		if (leaf) {
			await workspace.revealLeaf(leaf);
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<AntiDianSettings>,
		);
		if (this.geminiProvider && this.settings.model) {
			this.geminiProvider.setModel(this.settings.model);
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		if (this.geminiProvider && this.settings.model) {
			this.geminiProvider.setModel(this.settings.model);
		}
	}
}
