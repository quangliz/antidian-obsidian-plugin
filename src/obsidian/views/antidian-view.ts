import {
	HoverParent,
	HoverPopover,
	ItemView,
	MarkdownRenderer,
	WorkspaceLeaf,
	setIcon,
	setTooltip,
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
	formatTokens,
	AvailableModel,
	ModelGroup,
} from '../../core/models/antigravity-acp';
import { renderChangeSet } from './changeset-view';
import { ContextCardsView } from './context-cards-view';
import { ModelMenuController } from './model-menu-view';
import { PromptBarView } from './prompt-bar-view';
import { ThinkingStateView } from './thinking-state-view';
import { ANTI_DIAN_ICON } from '../icon';

export const ANTI_DIAN_VIEW_TYPE = 'anti-dian-sidebar';

export class AntiDianView extends ItemView implements HoverParent {
	hoverPopover: HoverPopover | null = null;
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
				this.plugin.settings.model ||
				this.plugin.antigravityProvider.getModel(),
			onSelectModel: (modelId) => this.selectModel(modelId),
			getAvailableModels: () => this.availableModels,
			getModelGroups: () => this.modelGroups,
			getAccountTier: () =>
				this.plugin.antigravityProvider.getAccountTier(),
			fetchUserQuota: () =>
				this.plugin.antigravityProvider.fetchUserQuota(),
			getContextUsage: () =>
				this.plugin.antigravityProvider.getContextUsage(),
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
		return ANTI_DIAN_ICON;
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
				!target.closest('.anti-dian-usage-popup') &&
				// The "View usage" menu item click that opened the panel bubbles here.
				!target.closest('.menu')
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
		});
		setIcon(newSessionBtn, 'plus');
		setTooltip(newSessionBtn, 'New chat session');
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
		this.plugin.antigravityProvider.setModel(modelId);
		void this.plugin.saveSettings();

		this.promptBar?.updateModelLabel(
			this.modelMenuController.formatModelLabel(modelId),
		);
		this.promptBar?.playRainbowSweep();
	}

	private startNewSession(): void {
		this.history = [];
		void this.agent.resetSession();
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
				await this.plugin.antigravityProvider.fetchAvailableModels();
			this.availableModels = models;
			this.modelGroups = groups;
			if (!this.plugin.settings.model && defaultModelId) {
				this.plugin.settings.model = defaultModelId;
				this.plugin.antigravityProvider.setModel(defaultModelId);
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

		const thinkingState = new ThinkingStateView(agentMsg, this.app, this, this);
		const answerEl = agentMsg.createDiv({ cls: 'anti-dian-answer-body' });
		let receivedMarkdown = '';
		let streamedMarkdown = '';
		let streamAnimationFrame: number | null = null;
		let streamLastFrame = 0;
		let streamSourceEnded = false;
		let resolveStreamComplete: (() => void) | null = null;
		let answerWaitingForThought = false;
		let streamRenderVersion = 0;
		let streamRenderScheduled = false;
		let streamingFinished = false;
		let renderSourcePath = '';
		const streamSpeed = 60;
		const streamChunkSize = Math.max(1, Math.round((streamSpeed - 25) / 10));
		const streamDelay = Math.max(1, Math.round(100 / Math.sqrt(streamSpeed)));

		const appendStreamCaret = () => {
			const target = (answerEl.lastElementChild ?? answerEl) as HTMLElement;
			target.createSpan({
				cls: 'anti-dian-stream-caret',
				attr: { 'aria-hidden': 'true' },
			});
		};
		const renderStreamedMarkdown = () => {
			if (streamRenderScheduled) return;
			streamRenderScheduled = true;
			window.requestAnimationFrame(() => {
				streamRenderScheduled = false;
				const version = streamRenderVersion;
				const markdown = streamedMarkdown;
				const rendered = answerEl.createDiv();
				rendered.detach();
				void MarkdownRenderer.render(
					this.app,
					markdown,
					rendered,
					renderSourcePath,
					this,
				).then(() => {
					if (streamingFinished || version !== streamRenderVersion) {
						if (!streamingFinished) renderStreamedMarkdown();
						return;
					}
					answerEl.replaceChildren(...Array.from(rendered.childNodes));
					appendStreamCaret();
					this.scrollToBottom();
				});
			});
		};
		const startTextStream = () => {
			if (streamAnimationFrame !== null) return;
			const advance = (timestamp: number) => {
				if (timestamp - streamLastFrame < streamDelay) {
					streamAnimationFrame = window.requestAnimationFrame(advance);
					return;
				}
				streamLastFrame = timestamp;
				streamedMarkdown = receivedMarkdown.slice(
					0,
					streamedMarkdown.length + streamChunkSize,
				);
				streamRenderVersion++;
				renderStreamedMarkdown();

				if (streamedMarkdown.length < receivedMarkdown.length) {
					streamAnimationFrame = window.requestAnimationFrame(advance);
				} else {
					streamAnimationFrame = null;
					if (streamSourceEnded) {
						resolveStreamComplete?.();
						resolveStreamComplete = null;
					}
				}
			};
			streamAnimationFrame = window.requestAnimationFrame(advance);
		};
		const waitForTextStream = (): Promise<void> => {
			if (streamedMarkdown.length >= receivedMarkdown.length) {
				return Promise.resolve();
			}
			return new Promise((resolve) => {
				resolveStreamComplete = resolve;
			});
		};

		try {
			const activeCtx: ActiveContext = this.promptBar.isContextIncluded()
				? this.contextService.getActiveContext()
				: {};
			renderSourcePath = activeCtx.activeFile ?? '';
			const result = await this.agent.run(
				text,
				activeCtx,
				this.history,
				(step: AgentStepEvent) => {
					if (step.type === 'answer_start') {
						if (streamAnimationFrame !== null) {
							window.cancelAnimationFrame(streamAnimationFrame);
							streamAnimationFrame = null;
						}
						receivedMarkdown = '';
						streamedMarkdown = '';
						streamLastFrame = 0;
						streamSourceEnded = false;
						streamRenderVersion++;
						streamingFinished = false;
						answerEl.empty();
						appendStreamCaret();
					} else if (step.type === 'answer_delta') {
						receivedMarkdown += step.text;
						if (thinkingState.isThoughtStreaming()) {
							if (!answerWaitingForThought) {
								answerWaitingForThought = true;
								void thinkingState.waitForThoughtStream().then(() => {
									answerWaitingForThought = false;
									startTextStream();
								});
							}
						} else {
							startTextStream();
						}
					} else {
						thinkingState.handleStep(step);
					}
				},
				mediaToSend.length > 0 ? mediaToSend : undefined,
				async () => {
					await thinkingState.waitForThoughtStream();
					await new Promise<void>((resolve) =>
						window.requestAnimationFrame(() =>
							window.requestAnimationFrame(() => resolve()),
						),
					);
				},
				this.plugin.settings.permissionMode ?? 'ask',
			);

			this.history = result.updatedHistory;
			thinkingState.settle();
			streamSourceEnded = true;
			await waitForTextStream();
			streamingFinished = true;
			streamRenderVersion++;
			answerEl.empty();

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
			thinkingState.settle();
			streamingFinished = true;
			if (streamAnimationFrame !== null) {
				window.cancelAnimationFrame(streamAnimationFrame);
				streamAnimationFrame = null;
			}
			streamRenderVersion++;
			answerEl.empty();
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

	private renderContextUsed(
		parent: HTMLElement,
		contextUsed: ContextReference[],
	): void {
		new ContextCardsView(parent, this.app, contextUsed);
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
