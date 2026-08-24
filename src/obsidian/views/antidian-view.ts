import {
	ItemView,
	MarkdownRenderer,
	WorkspaceLeaf,
	setIcon,
} from 'obsidian';
import type AntiDianPlugin from '../../main';
import {
	ActiveContext,
	ContextReference,
	ContextService,
} from '../../core/types/context';
import { Agent, AgentStepEvent } from '../../core/agent';
import { Message, MediaInput } from '../../core/types/model';
import { ChangeSetValidator } from '../../core/transactions';
import {
	fetchAvailableModels,
	formatTokens,
	AvailableModel,
	ModelGroup,
} from '../../core/models/antigravity-oauth';
import { renderChangeSet } from './changeset-view';
import { ModelMenuController } from './model-menu-view';
import { PromptBarView } from './prompt-bar-view';

export const ANTI_DIAN_VIEW_TYPE = 'anti-dian-sidebar';

interface ActionItem {
	id: string;
	name: string;
	args: Record<string, unknown>;
	output?: unknown;
	status: 'running' | 'done' | 'error';
	error?: string;
}

export class AntiDianView extends ItemView {
	private plugin: AntiDianPlugin;
	private contextService: ContextService;
	private agent: Agent;
	private validator?: ChangeSetValidator;
	private unsubscribeContext: (() => void) | null = null;
	private modelMenuController: ModelMenuController;
	private promptBar!: PromptBarView;

	private rootEl: HTMLElement | null = null;
	private topNavEl: HTMLElement | null = null;
	private centerContainerEl: HTMLElement | null = null;
	private messagesEl: HTMLElement | null = null;

	private availableModels: AvailableModel[] = [];
	private modelGroups: ModelGroup[] = [];
	private history: Message[] = [];
	private isRunning = false;

	// Live session usage tracking
	private sessionPromptTokens = 0;
	private sessionCandidateTokens = 0;
	private sessionTotalTokens = 0;
	private lastTurnPromptTokens = 0;

	constructor(leaf: WorkspaceLeaf, plugin: AntiDianPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.contextService = plugin.workspaceAdapter;
		this.agent = plugin.agent;
		this.validator = plugin.validator;

		this.modelMenuController = new ModelMenuController({
			getCurrentModelId: () =>
				this.plugin.settings.model || 'gemini-3.7-flash-high',
			onSelectModel: (modelId) => this.selectModel(modelId),
			getAvailableModels: () => this.availableModels,
			getModelGroups: () => this.modelGroups,
			getSessionStats: () => ({
				promptTokens: this.sessionPromptTokens,
				candidateTokens: this.sessionCandidateTokens,
				totalTokens: this.sessionTotalTokens,
			}),
		});
	}

	getViewType(): string {
		return ANTI_DIAN_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Anti-dian';
	}

	getIcon(): string {
		return 'bot';
	}

	async onOpen(): Promise<void> {
		this.rootEl = this.contentEl;
		this.rootEl.empty();
		this.rootEl.addClass('anti-dian-sidebar-container');
		this.rootEl.addClass('is-empty-session');

		this.renderTopNav();
		this.renderMessagesContainer();
		this.renderInputCard();

		this.unsubscribeContext = this.contextService.onContextChange(
			(context) => {
				this.updateContextNav(context);
			},
		);

		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			const target = evt.target as HTMLElement;
			if (
				this.modelMenuController.isOpen() &&
				!target.closest('.anti-dian-promptbar-model-pill') &&
				!target.closest('.anti-dian-model-pill') &&
				!target.closest('.anti-dian-model-menu') &&
				!target.closest('.anti-dian-effort-popup') &&
				!target.closest('.anti-dian-usage-popup')
			) {
				this.modelMenuController.closeMenu();
			}
		});

		void this.loadModels();
	}

	async onClose(): Promise<void> {
		if (this.unsubscribeContext) {
			this.unsubscribeContext();
			this.unsubscribeContext = null;
		}
		this.promptBar?.destroy();
		this.modelMenuController.closeMenu();
		this.contentEl.empty();
	}

	private renderTopNav(): void {
		if (!this.rootEl) return;
		this.topNavEl = this.rootEl.createDiv({ cls: 'anti-dian-top-nav' });

		const leftGroup = this.topNavEl.createDiv({
			cls: 'anti-dian-nav-left',
		});
		const folderIcon = leftGroup.createSpan({
			cls: 'anti-dian-nav-icon',
		});
		setIcon(folderIcon, 'folder');

		const vaultName = this.app.vault.getName() || 'anti-dian';
		leftGroup.createSpan({
			text: vaultName,
			cls: 'anti-dian-nav-title',
		});

		const chevronIcon = leftGroup.createSpan({
			cls: 'anti-dian-nav-chevron',
		});
		setIcon(chevronIcon, 'chevron-down');

		const rightGroup = this.topNavEl.createDiv({
			cls: 'anti-dian-nav-right',
		});

		const newSessionBtn = rightGroup.createEl('button', {
			cls: 'anti-dian-nav-btn',
			attr: { 'aria-label': 'New chat session' },
		});
		setIcon(newSessionBtn, 'plus');
		newSessionBtn.onclick = () => {
			this.startNewSession();
		};
	}

	private updateContextNav(context: ActiveContext): void {
		this.promptBar?.updateActiveNotePill(context);
	}

	private renderMessagesContainer(): void {
		if (!this.rootEl) return;
		this.messagesEl = this.rootEl.createDiv({
			cls: 'anti-dian-messages',
		});
	}

	private renderInputCard(): void {
		if (!this.rootEl) return;

		this.centerContainerEl = this.rootEl.createDiv({
			cls: 'anti-dian-center-card-container',
		});

		this.promptBar = new PromptBarView(
			this.centerContainerEl,
			this.app,
			this.plugin,
			{
				onSend: (text, media) => this.handleSend(text, media),
				onOpenModelMenu: (anchorEl) =>
					this.modelMenuController.toggleMenu(anchorEl),
				onPermissionChange: (mode) => {
					this.plugin.settings.permissionMode = mode;
					void this.plugin.saveSettings();
				},
				getCurrentModelLabel: () =>
					this.modelMenuController.formatModelLabel(),
				getActiveContext: () => this.contextService.getActiveContext(),
				onStartNewSession: () => this.startNewSession(),
			},
		);
	}

	private selectModel(modelId: string): void {
		this.plugin.settings.model = modelId;
		this.plugin.geminiProvider.setModel(modelId);
		void this.plugin.saveSettings();

		this.promptBar?.updateModelLabel(
			this.modelMenuController.formatModelLabel(modelId),
		);
		this.promptBar?.playRainbowSweep();
	}

	private startNewSession(): void {
		this.history = [];
		this.promptBar?.clearStagedMedia();
		this.promptBar?.setText('');
		this.promptBar?.focus();
		if (this.messagesEl) {
			this.messagesEl.empty();
		}
		if (this.rootEl) {
			this.rootEl.removeClass('has-chat');
			this.rootEl.addClass('is-empty-session');
		}
	}

	private async loadModels(): Promise<void> {
		try {
			const { models, defaultModelId, groups } =
				await fetchAvailableModels();
			this.availableModels = models;
			this.modelGroups = groups;
			if (!this.plugin.settings.model && defaultModelId) {
				this.plugin.settings.model = defaultModelId;
				this.plugin.geminiProvider.setModel(defaultModelId);
			}
			this.promptBar?.updateModelLabel();
		} catch {
			// Fallback defaults
		}
	}

	private async handleSend(
		text: string,
		mediaToSend: MediaInput[],
	): Promise<void> {
		if (!this.messagesEl || this.isRunning) {
			return;
		}
		if (!text && mediaToSend.length === 0) {
			return;
		}

		this.isRunning = true;
		this.promptBar.setDisabled(true);

		if (this.rootEl) {
			this.rootEl.removeClass('is-empty-session');
			this.rootEl.addClass('has-chat');
		}

		const userMsg = this.messagesEl.createDiv({
			cls: 'anti-dian-message anti-dian-message-user',
		});

		if (mediaToSend.length > 0) {
			const mediaRow = userMsg.createDiv({
				cls: 'anti-dian-user-media-row',
			});
			for (const m of mediaToSend) {
				if (m.type === 'image' && m.data) {
					mediaRow.createEl('img', {
						cls: 'anti-dian-user-media-img',
						attr: { src: m.data },
					});
				}
			}
		}

		if (text) {
			userMsg.createEl('p', { text });
		}

		this.scrollToBottom();

		const agentMsg = this.messagesEl.createDiv({
			cls: 'anti-dian-message anti-dian-message-agent',
		});

		const actionsContainer = agentMsg.createDiv({
			cls: 'anti-dian-actions-container',
		});
		const liveStatusEl = agentMsg.createDiv({
			cls: 'anti-dian-live-status',
		});
		const answerEl = agentMsg.createDiv({ cls: 'anti-dian-answer-body' });

		liveStatusEl.createSpan({
			text: 'Thinking...',
			cls: 'anti-dian-status-text',
		});

		const actions: ActionItem[] = [];

		try {
			const activeCtx: ActiveContext = this.promptBar.isContextIncluded()
				? this.contextService.getActiveContext()
				: {};
			const result = await this.agent.run(
				text,
				activeCtx,
				this.history,
				(step: AgentStepEvent) => {
					this.handleAgentStep(
						step,
						actions,
						actionsContainer,
						liveStatusEl,
					);
				},
				mediaToSend.length > 0 ? mediaToSend : undefined,
			);

			this.history = result.updatedHistory;
			liveStatusEl.remove();

			await MarkdownRenderer.render(
				this.app,
				result.answer,
				answerEl,
				activeCtx.activeFile ?? '',
				this,
			);

			if (result.contextUsed && result.contextUsed.length > 0) {
				this.renderContextUsed(agentMsg, result.contextUsed);
			}

			if (result.changeSet && result.changeSet.operations.length > 0) {
				await renderChangeSet(
					agentMsg,
					result.changeSet,
					this.plugin,
					this.validator,
				);
			}

			if (result.usage) {
				this.sessionPromptTokens += result.usage.promptTokens;
				this.sessionCandidateTokens += result.usage.candidatesTokens;
				this.sessionTotalTokens += result.usage.totalTokens;
				this.lastTurnPromptTokens = result.usage.promptTokens;
				this.renderUsageFooter(agentMsg, result.usage);
			}
		} catch (err) {
			liveStatusEl.remove();
			answerEl.createEl('p', {
				text: `Error: ${err instanceof Error ? err.message : String(err)}`,
				cls: 'anti-dian-error-text',
			});
		} finally {
			this.isRunning = false;
			this.promptBar.setDisabled(false);
			this.scrollToBottom();
		}
	}

	private handleAgentStep(
		step: AgentStepEvent,
		actions: ActionItem[],
		actionsContainer: HTMLElement,
		liveStatusEl: HTMLElement,
	): void {
		if (step.type === 'thinking') {
			liveStatusEl.empty();
			liveStatusEl.createSpan({
				text: 'Thinking...',
				cls: 'anti-dian-status-text',
			});
		} else if (step.type === 'tool_start') {
			actions.push({
				id: `act_${actions.length + 1}`,
				name: step.toolName,
				args: step.toolArgs,
				status: 'running',
			});
			this.renderActionsTray(actionsContainer, actions);

			liveStatusEl.empty();
			liveStatusEl.createSpan({
				text: `Running ${step.toolName}...`,
				cls: 'anti-dian-status-text',
			});
		} else if (step.type === 'tool_end') {
			const current = actions.find((a) => a.name === step.toolName);
			if (current) {
				current.status =
					step.toolOutput &&
					typeof step.toolOutput === 'object' &&
					'error' in step.toolOutput
						? 'error'
						: 'done';
				current.output = step.toolOutput;
				if (current.status === 'error') {
					current.error = String(
						(step.toolOutput as { error: unknown }).error,
					);
				}
			}
			this.renderActionsTray(actionsContainer, actions);
		} else if (step.type === 'error') {
			liveStatusEl.empty();
			liveStatusEl.createSpan({
				text: `Error: ${step.message}`,
				cls: 'anti-dian-error-text',
			});
		}
	}

	private renderActionsTray(
		container: HTMLElement,
		actions: ActionItem[],
	): void {
		container.empty();
		if (actions.length === 0) return;

		const details = container.createEl('details', {
			cls: 'anti-dian-actions-details',
		});

		const summary = details.createEl('summary', {
			cls: 'anti-dian-actions-summary',
		});
		summary.createSpan({
			text: `Actions (${actions.length} ${actions.length === 1 ? 'tool call' : 'tool calls'})`,
			cls: 'anti-dian-actions-title',
		});

		const list = details.createDiv({ cls: 'anti-dian-actions-list' });

		for (const act of actions) {
			const item = list.createDiv({ cls: 'anti-dian-action-item' });

			const top = item.createDiv({ cls: 'anti-dian-action-top' });
			top.createSpan({
				text: act.name,
				cls: 'anti-dian-action-name',
			});

			const badge = top.createSpan({
				cls: `anti-dian-action-badge action-badge-${act.status}`,
			});
			badge.setText(
				act.status === 'running'
					? 'running'
					: act.status === 'done'
						? 'done'
						: 'error',
			);

			if (act.args && Object.keys(act.args).length > 0) {
				const argsEl = item.createDiv({
					cls: 'anti-dian-action-args',
				});
				for (const [k, v] of Object.entries(act.args)) {
					const valStr =
						typeof v === 'object' && v !== null
							? JSON.stringify(v)
							: String(v);
					argsEl.createDiv({
						text: `${k}: ${valStr}`,
						cls: 'anti-dian-action-arg-line',
					});
				}
			}

			if (act.error) {
				item.createDiv({
					text: act.error,
					cls: 'anti-dian-action-error-msg',
				});
			}
		}
	}

	private renderContextUsed(
		parent: HTMLElement,
		contextUsed: ContextReference[],
	): void {
		const grouped = new Map<string, { reason: string; headings: string[] }>();

		for (const ref of contextUsed) {
			const existing = grouped.get(ref.path);
			if (existing) {
				if (ref.heading && !existing.headings.includes(ref.heading)) {
					existing.headings.push(ref.heading);
				}
			} else {
				grouped.set(ref.path, {
					reason: ref.reason,
					headings: ref.heading ? [ref.heading] : [],
				});
			}
		}

		const container = parent.createDiv({
			cls: 'anti-dian-context-used-container',
		});

		const header = container.createDiv({
			cls: 'anti-dian-context-used-header',
		});
		header.createSpan({ text: 'Context used', cls: 'anti-dian-context-used-title' });

		const list = container.createDiv({ cls: 'anti-dian-context-used-list' });

		for (const [filePath, info] of grouped.entries()) {
			const item = list.createDiv({ cls: 'anti-dian-context-used-item' });

			const noteName = filePath.replace(/\.md$/, '').split('/').pop();
			const link = item.createEl('a', {
				text: `[[${noteName}]]`,
				cls: 'anti-dian-context-used-link',
			});

			link.onclick = (e) => {
				e.preventDefault();
				void this.app.workspace.openLinkText(filePath, '', false);
			};

			if (info.headings.length > 0) {
				const headingsContainer = item.createDiv({
					cls: 'anti-dian-context-used-headings',
				});
				for (const h of info.headings) {
					headingsContainer.createDiv({
						text: `> #${h}`,
						cls: 'anti-dian-context-used-heading',
					});
				}
			}
		}
	}

	private renderUsageFooter(
		parent: HTMLElement,
		usage: {
			promptTokens: number;
			candidatesTokens: number;
			totalTokens: number;
		},
	): void {
		const footer = parent.createDiv({ cls: 'anti-dian-turn-usage-footer' });

		const inSpan = footer.createSpan({ cls: 'anti-dian-usage-item' });
		inSpan.setText(`${usage.promptTokens.toLocaleString()} in`);

		const outSpan = footer.createSpan({ cls: 'anti-dian-usage-item' });
		outSpan.setText(`${usage.candidatesTokens.toLocaleString()} out`);

		const ctxSpan = footer.createSpan({
			cls: 'anti-dian-usage-item anti-dian-usage-ctx',
		});
		ctxSpan.setText(`${formatTokens(usage.promptTokens)} ctx`);
	}

	private scrollToBottom(): void {
		if (this.messagesEl) {
			this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
		}
	}
}
