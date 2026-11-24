import {
	HoverParent,
	HoverPopover,
	ItemView,
	MarkdownRenderer,
	Notice,
	WorkspaceLeaf,
	setIcon,
	setTooltip,
} from 'obsidian';
import type AntiDianPlugin from '../../main';
import {
	ActiveContext,
	ContextService,
} from '../../core/types/context';
import { Agent, AgentStepEvent } from '../../core/agent';
import { Message, MediaInput } from '../../core/types/model';
import { ChangeSetValidator } from '../../core/transactions';
import {
	formatTokens,
	AcpSessionSummary,
	AvailableModel,
	ModelGroup,
	ReplayedAgentEvent,
	ReplayedMessage,
} from '../../core/models/antigravity-acp';
import { ModelMenuController } from './model-menu-view';
import { SessionMenuController } from './session-menu-view';
import { UNTITLED_SESSION } from './session-format';
import { mergeStoredTraces } from '../../core/sessions/trace';
import { loadAgyTranscriptTurns } from '../../core/sessions/transcript';
import { PromptBarView } from './prompt-bar-view';
import { ThinkingStateView } from './thinking-state-view';
import { linkifyCodeWikilinks, registerInternalLinkHandlers } from './note-link';
import { ANTI_DIAN_ICON } from '../icon';

export const ANTI_DIAN_VIEW_TYPE = 'anti-dian-sidebar';

export class AntiDianView extends ItemView implements HoverParent {
	hoverPopover: HoverPopover | null = null;
	private plugin: AntiDianPlugin;
	private contextService: ContextService;
	private agent: Agent;
	private validator?: ChangeSetValidator;
	private unsubscribeContext: (() => void) | null = null;
	private unsubscribeSessionInfo: (() => void) | null = null;
	private modelMenuController: ModelMenuController;
	private sessionMenu: SessionMenuController | null = null;
	private sessionTriggerEl: HTMLElement | null = null;
	private sessionTitleEl: HTMLElement | null = null;
	/** Session being loaded; its title is shown until the CLI confirms the switch. */
	private loadingSession: AcpSessionSummary | null = null;
	/** Title of a resumed session, kept until the CLI reports one of its own. */
	private resumedTitle: string | null = null;
	private promptBar!: PromptBarView;
	/** Trace of the current/last turn; holds any pending write approvals. */
	private activeThinking: ThinkingStateView | null = null;

	private rootEl: HTMLElement | null = null;
	private topNavEl: HTMLElement | null = null;
	private centerContainerEl: HTMLElement | null = null;
	private messagesEl: HTMLElement | null = null;

	private availableModels: AvailableModel[] = [];
	private modelGroups: ModelGroup[] = [];
	private history: Message[] = [];
	private isRunning = false;
	private turnToken = 0;

	// Live session usage tracking
	private sessionPromptTokens = 0;
	private sessionCandidateTokens = 0;
	private sessionTotalTokens = 0;
	private sessionCachedReadTokens = 0;
	private sessionThoughtTokens = 0;
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
			getCachedUserQuota: () =>
				this.plugin.antigravityProvider.getCachedUserQuota(),
			fetchUserQuota: () =>
				this.plugin.antigravityProvider.fetchUserQuota(),
			getContextUsage: () =>
				this.plugin.antigravityProvider.getContextUsage(),
			getSessionStats: () => ({
				promptTokens: this.sessionPromptTokens,
				candidateTokens: this.sessionCandidateTokens,
				totalTokens: this.sessionTotalTokens,
				cachedReadTokens: this.sessionCachedReadTokens,
				thoughtTokens: this.sessionThoughtTokens,
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

		this.unsubscribeSessionInfo =
			this.plugin.antigravityProvider.onSessionInfoChange(() => {
				this.updateSessionTitle();
			});

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
			if (
				this.sessionMenu?.isOpen() &&
				!target.closest('.anti-dian-session-menu') &&
				!target.closest('.anti-dian-session-trigger')
			) {
				this.sessionMenu.close();
			}
		});

		this.registerDomEvent(this.rootEl, 'keydown', (evt: KeyboardEvent) => {
			if (evt.key === 'Escape' && this.isRunning && !evt.defaultPrevented) {
				evt.preventDefault();
				this.handleCancel();
			}
		});

		void this.loadModels();
	}

	async onClose(): Promise<void> {
		// Cancel any active run and pending write approvals so nothing hangs after close.
		this.turnToken++;
		this.handleCancel();
		if (this.unsubscribeContext) {
			this.unsubscribeContext();
			this.unsubscribeContext = null;
		}
		this.unsubscribeSessionInfo?.();
		this.unsubscribeSessionInfo = null;
		this.sessionMenu?.close();
		this.promptBar?.destroy();
		this.modelMenuController.closeMenu();
		this.contentEl.empty();
	}

	private renderTopNav(): void {
		if (!this.rootEl) return;
		this.topNavEl = this.rootEl.createDiv({ cls: 'anti-dian-top-nav' });

		const vaultName = this.app.vault.getName() || 'anti-dian';
		const trigger = this.topNavEl.createEl('button', {
			cls: 'anti-dian-nav-left anti-dian-session-trigger',
			attr: { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
		});
		this.sessionTriggerEl = trigger;
		const sessionIcon = trigger.createSpan({ cls: 'anti-dian-nav-icon' });
		setIcon(sessionIcon, 'messages-square');
		this.sessionTitleEl = trigger.createSpan({ cls: 'anti-dian-nav-title' });
		const chevronIcon = trigger.createSpan({
			cls: 'anti-dian-nav-chevron',
		});
		setIcon(chevronIcon, 'chevron-down');
		setTooltip(trigger, `Sessions in ${vaultName}`);

		this.sessionMenu = new SessionMenuController(this.topNavEl, {
			getVaultName: () => vaultName,
			listSessions: () => this.agent.listSessions(),
			getCurrentSessionId: () =>
				this.plugin.antigravityProvider.getSessionId(),
			onSelectSession: (session) => void this.switchSession(session),
			onNewSession: () => this.startNewSession(),
		});
		trigger.onclick = (e) => {
			e.stopPropagation();
			this.modelMenuController.closeMenu();
			this.sessionMenu?.toggle(trigger);
		};
		this.updateSessionTitle();

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

	private updateSessionTitle(): void {
		if (!this.sessionTitleEl) return;
		const provider = this.plugin.antigravityProvider;
		const title = this.loadingSession
			? (this.loadingSession.title ?? UNTITLED_SESSION)
			: (provider.getSessionTitle() ??
				this.resumedTitle ??
				(provider.getSessionId() && this.history.length > 0
					? UNTITLED_SESSION
					: 'New chat'));
		this.sessionTitleEl.setText(title);
		this.sessionTriggerEl?.toggleClass('is-loading', !!this.loadingSession);
	}

	private async switchSession(session: AcpSessionSummary): Promise<void> {
		if (session.sessionId === this.plugin.antigravityProvider.getSessionId()) {
			return;
		}
		if (this.isRunning) {
			new Notice('Stop the current response before switching sessions.');
			return;
		}
		const myToken = ++this.turnToken;
		this.activeThinking?.cancelPendingApprovals();
		this.activeThinking = null;
		this.loadingSession = session;
		this.resumedTitle = null;
		this.updateSessionTitle();
		this.clearMessages();
		const loadingEl = this.messagesEl?.createDiv({
			cls: 'anti-dian-session-loading',
			text: 'Loading session…',
		});
		if (this.rootEl) {
			this.rootEl.removeClass('is-empty-session');
			this.rootEl.addClass('has-chat');
		}

		try {
			const [replayed, stored] = await Promise.all([
				this.agent.loadSession(session.sessionId),
				loadAgyTranscriptTurns(session.sessionId).catch(() => []),
			]);
			if (myToken !== this.turnToken) return;
			loadingEl?.remove();
			this.history = [];
			this.resetSessionStats();
			this.resumedTitle = session.title ?? null;
			await this.renderReplayedHistory(mergeStoredTraces(replayed, stored));
		} catch (err) {
			if (myToken !== this.turnToken) return;
			loadingEl?.remove();
			this.resetEmptyState();
			new Notice(
				`Could not open session: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			if (myToken === this.turnToken) {
				this.loadingSession = null;
				this.updateSessionTitle();
				this.promptBar?.focus();
			}
		}
	}

	private async renderReplayedHistory(messages: ReplayedMessage[]): Promise<void> {
		if (!this.messagesEl) return;
		if (messages.length === 0) {
			this.resetEmptyState();
			return;
		}
		for (const message of messages) {
			if (message.role === 'user') {
				const userMsg = this.messagesEl.createDiv({
					cls: 'anti-dian-message anti-dian-message-user is-replayed',
				});
				userMsg.createEl('p', { text: message.text });
			} else {
				const agentMsg = this.messagesEl.createDiv({
					cls: 'anti-dian-message anti-dian-message-agent is-replayed',
				});
				if (message.events && message.events.length > 0) {
					this.renderReplayedTrace(agentMsg, message.events, message.durationMs);
				}
				const answerEl = agentMsg.createDiv({ cls: 'anti-dian-answer-body' });
				await MarkdownRenderer.render(this.app, message.text, answerEl, '', this);
				linkifyCodeWikilinks(this.app, answerEl, '');
				if (message.usage) this.renderUsageFooter(agentMsg, message.usage);
			}
		}
		this.scrollToBottom();
	}

	/** Rebuilds a stored turn's reasoning and tool trace with the live trace view. */
	private renderReplayedTrace(
		agentMsg: HTMLElement,
		events: ReplayedAgentEvent[],
		durationMs?: number,
	): void {
		const trace = new ThinkingStateView(agentMsg, this.app, this, {
			hoverParent: this,
			getShowRawToolData: () => this.plugin.settings.showRawToolData ?? false,
		});
		for (const event of events) {
			if (event.type === 'thought') {
				trace.handleStep({ type: 'thought_delta', text: event.text });
				continue;
			}
			trace.handleStep({
				type: 'tool_start',
				toolName: event.toolName,
				toolArgs: event.toolArgs,
				callId: event.callId,
			});
			if (event.status === 'completed' || event.status === 'failed') {
				trace.handleStep({
					type: 'tool_end',
					toolName: event.toolName,
					toolOutput: event.output,
					callId: event.callId,
				});
			}
		}
		trace.settle({ replayed: true, durationMs });
	}

	private clearMessages(): void {
		this.messagesEl?.empty();
	}

	private resetEmptyState(): void {
		this.clearMessages();
		if (this.rootEl) {
			this.rootEl.removeClass('has-chat');
			this.rootEl.addClass('is-empty-session');
		}
	}

	private resetSessionStats(): void {
		this.sessionPromptTokens = 0;
		this.sessionCandidateTokens = 0;
		this.sessionTotalTokens = 0;
		this.sessionCachedReadTokens = 0;
		this.sessionThoughtTokens = 0;
		this.lastTurnPromptTokens = 0;
	}

	private updateContextNav(context: ActiveContext): void {
		this.promptBar?.updateActiveNotePill(context);
	}

	private renderMessagesContainer(): void {
		if (!this.rootEl) return;
		this.messagesEl = this.rootEl.createDiv({
			cls: 'anti-dian-messages',
		});
		// Wikilinks in rendered answers and thoughts open notes like in the editor.
		registerInternalLinkHandlers(this, this.app, this.messagesEl, () => '', this);
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
				onCancel: () => this.handleCancel(),
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

	private handleCancel(): void {
		if (!this.isRunning) return;
		this.activeThinking?.cancelPendingApprovals();
		this.agent.cancel();
	}

	private startNewSession(): void {
		this.turnToken++;
		if (this.isRunning) {
			this.handleCancel();
			this.isRunning = false;
			this.promptBar?.setRunning(false);
		} else {
			this.activeThinking?.cancelPendingApprovals();
		}
		this.history = [];
		this.loadingSession = null;
		this.resumedTitle = null;
		this.resetSessionStats();
		void this.agent.resetSession();
		this.updateSessionTitle();
		this.promptBar?.clearStagedMedia();
		this.promptBar?.setText('');
		this.promptBar?.focus();
		this.resetEmptyState();
	}

	private async loadModels(): Promise<void> {
		const cached = this.plugin.antigravityProvider.getCachedAvailableModels();
		if (cached && cached.models.length > 0) {
			this.availableModels = cached.models;
			this.modelGroups = cached.groups;
			if (!this.plugin.settings.model && cached.defaultModelId) {
				this.plugin.settings.model = cached.defaultModelId;
				this.plugin.antigravityProvider.setModel(cached.defaultModelId);
			}
			this.promptBar?.updateModelLabel();
		}

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
			// Keep cached or fallback defaults
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

		const myToken = ++this.turnToken;
		this.isRunning = true;
		this.promptBar.setRunning(true);

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

		const thinkingState = new ThinkingStateView(agentMsg, this.app, this, {
			hoverParent: this,
			getShowRawToolData: () => this.plugin.settings.showRawToolData ?? false,
			undoChange: async (changeSetId) => {
				await this.plugin.applicator.rollback(changeSetId);
			},
		});
		this.activeThinking = thinkingState;
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
					linkifyCodeWikilinks(this.app, rendered, renderSourcePath);
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
				// Ask mode: each write waits here for Approve / Reject on its tool row
				// and (when enabled) inline in the open Markdown editor.
				async (request) => {
					const inlineEnabled =
						this.plugin.settings.enableInlineDiff !== false;
					if (inlineEnabled) {
						this.plugin.inlineDiffController.showPendingReview(
							request,
							(decision) => {
								thinkingState.resolveApproval(request.callId, decision);
							},
						);
					}
					try {
						return await thinkingState.requestApproval(request);
					} finally {
						this.plugin.inlineDiffController.clearPendingReview(
							request.callId,
						);
					}
				},
			);

			if (myToken !== this.turnToken) {
				if (streamAnimationFrame !== null) {
					window.cancelAnimationFrame(streamAnimationFrame);
					streamAnimationFrame = null;
				}
				return;
			}

			this.history = result.updatedHistory;
			this.updateSessionTitle();

			if (result.cancelled) {
				thinkingState.settle({ cancelled: true });
				streamingFinished = true;
				if (streamAnimationFrame !== null) {
					window.cancelAnimationFrame(streamAnimationFrame);
					streamAnimationFrame = null;
				}
				streamRenderVersion++;
				answerEl.empty();

				const partialAnswer = result.answer || streamedMarkdown.trim();
				if (partialAnswer) {
					await MarkdownRenderer.render(
						this.app,
						partialAnswer,
						answerEl,
						activeCtx.activeFile ?? '',
						this,
					);
					linkifyCodeWikilinks(this.app, answerEl, activeCtx.activeFile ?? '');
				}
				answerEl.createEl('p', {
					text: 'Stopped',
					cls: 'anti-dian-stopped-text',
				});
			} else {
				thinkingState.settle();
				streamSourceEnded = true;
				await waitForTextStream();
				if (myToken !== this.turnToken) return;
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
				linkifyCodeWikilinks(this.app, answerEl, activeCtx.activeFile ?? '');
			}

			if (result.contextUsed && result.contextUsed.length > 0) {
				thinkingState.setAmbientContext(result.contextUsed);
			}

			if (result.usage) {
				this.sessionPromptTokens += result.usage.promptTokens;
				this.sessionCandidateTokens += result.usage.candidatesTokens;
				this.sessionTotalTokens += result.usage.totalTokens;
				this.sessionCachedReadTokens += result.usage.cachedReadTokens;
				this.sessionThoughtTokens += result.usage.thoughtTokens;
				this.lastTurnPromptTokens = result.usage.promptTokens;
				this.renderUsageFooter(agentMsg, result.usage);
			}
		} catch (err) {
			if (myToken !== this.turnToken) return;
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
			if (myToken === this.turnToken) {
				this.isRunning = false;
				this.promptBar.setRunning(false);
				this.scrollToBottom();
			}
		}
	}

	private renderUsageFooter(
		parent: HTMLElement,
		usage: {
			promptTokens: number;
			candidatesTokens: number;
			totalTokens: number;
			cachedReadTokens: number;
			cachedWriteTokens: number;
			thoughtTokens: number;
		},
	): void {
		const footer = parent.createDiv({ cls: 'anti-dian-turn-usage-footer' });

		const inSpan = footer.createSpan({ cls: 'anti-dian-usage-item' });
		inSpan.setText(`${usage.promptTokens.toLocaleString()} in`);
		// Cached input is part of "in"; only shown when the provider reports it.
		if (usage.cachedReadTokens > 0) {
			const cached = footer.createSpan({
				cls: 'anti-dian-usage-item anti-dian-usage-cached',
				text: `${formatTokens(usage.cachedReadTokens)} cached`,
			});
			const pct =
				usage.promptTokens > 0
					? Math.round((usage.cachedReadTokens / usage.promptTokens) * 100)
					: 0;
			setTooltip(
				cached,
				`${usage.cachedReadTokens.toLocaleString()} input tokens read from cache${pct ? ` (${pct}% of input)` : ''}`,
			);
		}

		const outSpan = footer.createSpan({ cls: 'anti-dian-usage-item' });
		outSpan.setText(`${usage.candidatesTokens.toLocaleString()} out`);
		if (usage.thoughtTokens > 0) {
			const thought = footer.createSpan({
				cls: 'anti-dian-usage-item anti-dian-usage-thought',
				text: `${formatTokens(usage.thoughtTokens)} thinking`,
			});
			setTooltip(thought, `${usage.thoughtTokens.toLocaleString()} reasoning tokens`);
		}

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
