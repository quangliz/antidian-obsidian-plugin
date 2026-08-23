import { Plugin, WorkspaceLeaf } from 'obsidian';
import {
	DEFAULT_SETTINGS,
	AntiDianSettings,
	AntiDianSettingTab,
} from './settings';
import {
	ANTI_DIAN_VIEW_TYPE,
	AntiDianView,
} from './obsidian/views/antidian-view';
import { ObsidianWorkspaceAdapter } from './obsidian/adapters/workspace';
import { ObsidianVaultAdapter } from './obsidian/adapters/vault';
import { GeminiProvider } from './core/models/gemini-provider';
import {
	ChangeStagingManager,
	ChangeSetValidator,
	ChangeSetDiffGenerator,
	ChangeSetApplicator,
} from './core/transactions';
import {
	ToolRegistry,
	createSearchNotesTool,
	createReadNoteTool,
	createCreateNoteTool,
	createPatchNoteTool,
} from './core/tools';
import { Agent } from './core/agent';
import { registerCommands } from './obsidian/commands';

export default class AntiDianPlugin extends Plugin {
	settings!: AntiDianSettings;
	workspaceAdapter!: ObsidianWorkspaceAdapter;
	vaultAdapter!: ObsidianVaultAdapter;
	stagingManager!: ChangeStagingManager;
	validator!: ChangeSetValidator;
	diffGenerator!: ChangeSetDiffGenerator;
	applicator!: ChangeSetApplicator;
	geminiProvider!: GeminiProvider;
	toolRegistry!: ToolRegistry;
	agent!: Agent;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.workspaceAdapter = new ObsidianWorkspaceAdapter(this.app);
		this.vaultAdapter = new ObsidianVaultAdapter(this.app);
		this.stagingManager = new ChangeStagingManager();
		this.validator = new ChangeSetValidator(this.vaultAdapter);
		this.diffGenerator = new ChangeSetDiffGenerator(this.vaultAdapter);
		this.applicator = new ChangeSetApplicator(
			this.vaultAdapter,
			this.validator,
		);

		this.geminiProvider = new GeminiProvider({
			model: this.settings.model,
		});

		this.toolRegistry = new ToolRegistry();
		this.toolRegistry.register(createSearchNotesTool(this.vaultAdapter));
		this.toolRegistry.register(createReadNoteTool(this.vaultAdapter));
		this.toolRegistry.register(createCreateNoteTool(this.stagingManager));
		this.toolRegistry.register(createPatchNoteTool(this.stagingManager));

		this.agent = new Agent({
			provider: this.geminiProvider,
			tools: this.toolRegistry,
			stagingManager: this.stagingManager,
		});

		this.registerView(
			ANTI_DIAN_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new AntiDianView(leaf, this),
		);

		this.addRibbonIcon('bot', 'Open anti-dian', () => {
			void this.activateView();
		});

		registerCommands(this);

		this.addSettingTab(new AntiDianSettingTab(this.app, this));
	}

	onunload(): void {
		this.workspaceAdapter?.destroy();
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
