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
import type { SelectionSnippet } from './obsidian/views/prompt-bar-view';
import { ObsidianWorkspaceAdapter } from './obsidian/adapters/workspace';
import { ObsidianVaultAdapter } from './obsidian/adapters/vault';
import { ObsidianSkillAdapter } from './obsidian/adapters/skills';
import { AntigravityProvider } from './core/models/antigravity-provider';
import { McpToolServer } from './core/models/mcp-tool-server';
import {
	ChangeStagingManager,
	ChangeSetValidator,
	ChangeSetDiffGenerator,
	ChangeSetApplicator,
	StagedVaultOverlay,
	MutationGate,
} from './core/transactions';
import { ContextCompiler } from './core/context/compiler';
import {
	ToolRegistry,
	createListNotesTool,
	createGetNoteOutlineTool,
	createSearchNotesTool,
	createReadNoteTool,
	createCreateNoteTool,
	createEditNoteTool,
	createPatchNoteTool,
	createReplaceBlockTool,
	createAppendNoteTool,
	createUpdateFrontmatterTool,
	createListSkillsTool,
	createLoadSkillTool,
} from './core/tools';
import { Agent, DEFAULT_AGENT_SYSTEM_PROMPT } from './core/agent';
import { registerCommands } from './obsidian/commands';
import { InlineDiffController } from './obsidian/editor/inline-diff';
import { ANTI_DIAN_HOVER_SOURCE } from './obsidian/views/note-link';
import { ANTI_DIAN_ICON, registerAntiDianIcon } from './obsidian/icon';

export default class AntiDianPlugin extends Plugin {
	settings!: AntiDianSettings;
	workspaceAdapter!: ObsidianWorkspaceAdapter;
	vaultAdapter!: ObsidianVaultAdapter;
	skillAdapter!: ObsidianSkillAdapter;
	stagingManager!: ChangeStagingManager;
	vaultOverlay!: StagedVaultOverlay;
	contextCompiler!: ContextCompiler;
	validator!: ChangeSetValidator;
	diffGenerator!: ChangeSetDiffGenerator;
	applicator!: ChangeSetApplicator;
	mcpToolServer!: McpToolServer;
	antigravityProvider!: AntigravityProvider;
	inlineDiffController!: InlineDiffController;
	toolRegistry!: ToolRegistry;
	agent!: Agent;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.workspaceAdapter = new ObsidianWorkspaceAdapter(this.app);
		this.vaultAdapter = new ObsidianVaultAdapter(this.app);
		this.skillAdapter = new ObsidianSkillAdapter(this.app);
		this.stagingManager = new ChangeStagingManager();
		this.vaultOverlay = new StagedVaultOverlay(
			this.vaultAdapter,
			this.stagingManager,
		);
		this.contextCompiler = new ContextCompiler({
			vaultService: this.vaultAdapter,
			skillService: this.skillAdapter,
		});
		this.validator = new ChangeSetValidator(this.vaultAdapter);
		this.diffGenerator = new ChangeSetDiffGenerator(this.vaultAdapter);
		this.applicator = new ChangeSetApplicator(
			this.vaultAdapter,
			this.validator,
		);

		this.toolRegistry = new ToolRegistry();
		this.toolRegistry.register(createListNotesTool(this.vaultAdapter));
		this.toolRegistry.register(
			createGetNoteOutlineTool(this.vaultAdapter, this.vaultOverlay),
		);
		this.toolRegistry.register(createSearchNotesTool(this.vaultAdapter));
		this.toolRegistry.register(
			createReadNoteTool(this.vaultAdapter, this.vaultOverlay),
		);
		this.toolRegistry.register(createCreateNoteTool(this.stagingManager));
		this.toolRegistry.register(createPatchNoteTool(this.stagingManager));
		this.toolRegistry.register(createReplaceBlockTool(this.stagingManager));
		this.toolRegistry.register(createAppendNoteTool(this.stagingManager));
		this.toolRegistry.register(
			createUpdateFrontmatterTool(this.stagingManager),
		);
		this.toolRegistry.register(createEditNoteTool(this.stagingManager));
		this.toolRegistry.register(createListSkillsTool(this.skillAdapter));
		this.toolRegistry.register(createLoadSkillTool(this.skillAdapter));

		this.mcpToolServer = new McpToolServer(this.toolRegistry);

		const vaultBasePath = (
			this.app.vault.adapter as { basePath?: string }
		).basePath;

		this.antigravityProvider = new AntigravityProvider({
			cliPath: this.settings.cliPath,
			caCertificates: this.settings.caCertificates,
			cwd: vaultBasePath,
			model: this.settings.model || undefined,
			systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
			mcpToolServer: this.mcpToolServer,
			initialCache: this.settings.cachedMetadata,
			onCacheUpdate: (cache) => {
				this.settings.cachedMetadata = cache;
				void this.saveData(this.settings);
			},
		});

		this.inlineDiffController = new InlineDiffController(this.app);
		this.registerEditorExtension(
			this.inlineDiffController.getEditorExtension(),
		);

		this.agent = new Agent({
			provider: this.antigravityProvider,
			tools: this.toolRegistry,
			stagingManager: this.stagingManager,
			mutationGate: new MutationGate({
				staging: this.stagingManager,
				validator: this.validator,
				diffGenerator: this.diffGenerator,
				applicator: this.applicator,
				vault: this.vaultAdapter,
			}),
			contextCompiler: this.contextCompiler,
		});

		registerAntiDianIcon();
		this.registerView(
			ANTI_DIAN_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new AntiDianView(leaf, this),
		);
		this.registerHoverLinkSource(ANTI_DIAN_HOVER_SOURCE, {
			display: 'Anti-dian',
			defaultMod: true,
		});

		this.addRibbonIcon(ANTI_DIAN_ICON, 'Open anti-dian', () => {
			void this.activateView();
		});

		registerCommands(this);

		this.addSettingTab(new AntiDianSettingTab(this.app, this));

		this.antigravityProvider.warmup();
	}

	onunload(): void {
		this.inlineDiffController?.clearAll();
		this.workspaceAdapter?.destroy();
		void this.antigravityProvider?.destroy();
	}

	async activateView(): Promise<AntiDianView | null> {
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
			return leaf.view instanceof AntiDianView ? leaf.view : null;
		}
		return null;
	}

	async addSelectionToChat(snippet: SelectionSnippet): Promise<void> {
		const view = await this.activateView();
		view?.addSelectionToPrompt(snippet);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<AntiDianSettings>,
		);
		if (this.antigravityProvider) {
			this.antigravityProvider.setCliPath(this.settings.cliPath);
			this.antigravityProvider.setCaCertificates(
				this.settings.caCertificates,
			);
			if (this.settings.model) {
				this.antigravityProvider.setModel(this.settings.model);
			}
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		if (this.antigravityProvider) {
			this.antigravityProvider.setCliPath(this.settings.cliPath);
			this.antigravityProvider.setCaCertificates(
				this.settings.caCertificates,
			);
			if (this.settings.model) {
				this.antigravityProvider.setModel(this.settings.model);
			}
		}
	}
}
