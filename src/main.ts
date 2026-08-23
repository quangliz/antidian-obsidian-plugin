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

export default class AntiDianPlugin extends Plugin {
	settings!: AntiDianSettings;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(
			ANTI_DIAN_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new AntiDianSidebarView(leaf),
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

	onunload(): void {}

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
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
