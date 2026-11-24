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
import { StreamRenderLoop } from './stream-render-loop';
import logoUrl from '../../../assets/logo-hero.png';
import { formatForkedTitle, UNTITLED_SESSION } from './session-format';
import { mergeStoredTraces } from '../../core/sessions/trace';
import {
	deleteAgySessionData,
	forkedTurnsToReplayedMessages,
	loadAgyTranscriptTurns,
	storedTurnsToReplayedMessages,
} from '../../core/sessions/transcript';
import type { StoredTurnTrace } from '../../core/types/sessions';
import { PromptBarView } from './prompt-bar-view';
import { ThinkingStateView } from './thinking-state-view';
import { linkifyCodeWikilinks, registerInternalLinkHandlers } from './note-link';
import { ANTI_DIAN_ICON } from '../icon';

export const ANTI_DIAN_VIEW_TYPE = 'anti-dian-sidebar';

interface RenderedTurn {
	userGroupEl: HTMLElement;
	agentEl?: HTMLElement;
	userText: string;
	agentText?: string;
	historyStartIndex: number;
	thinkingState?: ThinkingStateView;
}

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
	private sessionTitleEl: HTMLElement | null = null;
	/** Session being loaded; its title is shown until the CLI confirms the switch. */
	private loadingSession: AcpSessionSummary | null = null;
	/** Title of a resumed session, kept until the CLI reports one of its own. */
	private resumedTitle: string | null = null;
	private promptBar!: PromptBarView;
	/** Trace of the current/last turn; holds any pending write approvals. */
	private activeThinking: ThinkingStateView | null = null;
	private renderedTurns: RenderedTurn[] = [];
	/** Pending fork parent info, saved once the new forked ACP session gets an ID. */
	private pendingForkParent: {
		parentId: string;
		title?: string;
		parentTurnCount: number;
	} | null = null;

	private rootEl: HTMLElement | null = null;
	private heroTitleEl: HTMLElement | null = null;
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
				this.recordPendingForkIfReady();
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
				!target.closest('.anti-dian-session-drawer-panel') &&
				!target.closest('.anti-dian-session-trigger') &&
				!target.closest('.menu')
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
		this.sessionMenu = new SessionMenuController(this.rootEl, {
			getVaultName: () => vaultName,
			listSessions: async () => {
				const deleted = new Set(this.plugin.settings.deletedSessions ?? []);
				const sessions = await this.agent.listSessions();
				return deleted.size > 0
					? sessions.filter((s) => !deleted.has(s.sessionId))
					: sessions;
			},
			getCurrentSessionId: () =>
				this.plugin.antigravityProvider.getSessionId(),
			getSessionForks: () => this.plugin.settings.sessionForks ?? {},
			getSessionTitles: () => this.plugin.settings.sessionTitles ?? {},
			onSelectSession: (session) => void this.switchSession(session),
			onNewSession: () => this.startNewSession(),
			onRenameSession: (sessionId, newTitle) =>
				this.renameSession(sessionId, newTitle),
			onDeleteSession: (sessionId) => void this.deleteSession(sessionId),
		});

		const leftGroup = this.topNavEl.createDiv({ cls: 'anti-dian-nav-left' });
		const addDrawerButton = (icon: string, tooltip: string, search: boolean) => {
			const btn = leftGroup.createEl('button', {
				cls: 'anti-dian-nav-btn anti-dian-session-trigger',
				attr: { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
			});
			setIcon(btn, icon);
			setTooltip(btn, tooltip);
			btn.onclick = (e) => {
				e.stopPropagation();
				this.modelMenuController.closeMenu();
				this.sessionMenu?.toggle(btn, { search });
			};
			return btn;
		};
		addDrawerButton('panel-left', `Conversations in ${vaultName}`, false);
		addDrawerButton('search', 'Search conversations', true);

		this.sessionTitleEl = this.topNavEl.createSpan({ cls: 'anti-dian-nav-title' });
		this.updateSessionTitle();

		const rightGroup = this.topNavEl.createDiv({
			cls: 'anti-dian-nav-right',
		});

		const newSessionBtn = rightGroup.createEl('button', {
			cls: 'anti-dian-nav-btn',
		});
		setIcon(newSessionBtn, 'plus');
		setTooltip(newSessionBtn, 'New conversation');
		newSessionBtn.onclick = () => {
			this.sessionMenu?.close();
			this.startNewSession();
		};
	}

	private updateSessionTitle(): void {
		if (!this.sessionTitleEl) return;
		const provider = this.plugin.antigravityProvider;
		const currentId = provider.getSessionId();
		const customTitle = currentId
			? this.plugin.settings.sessionTitles?.[currentId]?.trim()
			: undefined;
		const title = this.loadingSession
			? (this.plugin.settings.sessionTitles?.[this.loadingSession.sessionId]?.trim() ||
				this.loadingSession.title ||
				UNTITLED_SESSION)
			: (customTitle ??
				provider.getSessionTitle() ??
				this.resumedTitle ??
				(currentId && this.history.length > 0
					? UNTITLED_SESSION
					: 'New chat'));
		this.sessionTitleEl.setText(title);
		this.sessionTitleEl.setAttribute('title', title);
		this.sessionTitleEl.toggleClass('is-loading', !!this.loadingSession);
	}

	private renameSession(sessionId: string, newTitle: string): void {
		const trimmed = newTitle.trim();
		if (!trimmed) return;
		const titles = { ...(this.plugin.settings.sessionTitles ?? {}) };
		titles[sessionId] = trimmed;
		this.plugin.settings.sessionTitles = titles;
		void this.plugin.saveData(this.plugin.settings);

		if (this.plugin.antigravityProvider.getSessionId() === sessionId) {
			this.resumedTitle = trimmed;
			this.updateSessionTitle();
		}
	}

	private async deleteSession(sessionId: string): Promise<void> {
		const deleted = new Set(this.plugin.settings.deletedSessions ?? []);
		deleted.add(sessionId);
		this.plugin.settings.deletedSessions = [...deleted];

		if (this.plugin.settings.sessionTitles?.[sessionId]) {
			const titles = { ...this.plugin.settings.sessionTitles };
			delete titles[sessionId];
			this.plugin.settings.sessionTitles = titles;
		}
		if (this.plugin.settings.sessionForks?.[sessionId]) {
			const forks = { ...this.plugin.settings.sessionForks };
			delete forks[sessionId];
			this.plugin.settings.sessionForks = forks;
		}

		await this.plugin.saveData(this.plugin.settings);
		void deleteAgySessionData(sessionId);

		if (this.plugin.antigravityProvider.getSessionId() === sessionId) {
			this.startNewSession();
		}
		new Notice('Conversation deleted.');
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
		this.pendingForkParent = null;
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
			const childMessages = mergeStoredTraces(replayed, stored);
			const prefixMessages = await this.resolveForkPrefixMessages(
				session.sessionId,
				stored,
			);
			if (myToken !== this.turnToken) return;
			loadingEl?.remove();
			this.history = [];
			this.resetSessionStats();
			const fork = this.plugin.settings.sessionForks?.[session.sessionId];
			const customTitle =
				this.plugin.settings.sessionTitles?.[session.sessionId];
			this.resumedTitle =
				customTitle?.trim() ||
				(fork ? formatForkedTitle(session, fork) : (session.title ?? null));
			await this.renderReplayedHistory([...prefixMessages, ...childMessages], {
				forkDividerAt: prefixMessages.length > 0 ? prefixMessages.length : undefined,
			});
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

	private async resolveForkPrefixMessages(
		sessionId: string,
		childStored: StoredTurnTrace[],
		visited: Set<string> = new Set(),
	): Promise<ReplayedMessage[]> {
		if (visited.has(sessionId)) return [];
		visited.add(sessionId);

		const fork = this.plugin.settings.sessionForks?.[sessionId];
		const fallbackForkTurns = childStored[0]?.forkedContext;

		if (fork?.parentId) {
			const parentStored = await loadAgyTranscriptTurns(fork.parentId).catch(
				() => [],
			);
			const grandPrefix = await this.resolveForkPrefixMessages(
				fork.parentId,
				parentStored,
				visited,
			);
			const parentMessages = [
				...grandPrefix,
				...storedTurnsToReplayedMessages(parentStored),
			];
			if (parentMessages.length > 0) {
				const turnLimit = fork.parentTurnCount ?? fallbackForkTurns?.length;
				if (turnLimit !== undefined && turnLimit > 0) {
					let userTurns = 0;
					const sliced: ReplayedMessage[] = [];
					for (const msg of parentMessages) {
						if (msg.role === 'user') {
							if (userTurns >= turnLimit) break;
							userTurns++;
						}
						sliced.push(msg);
					}
					return sliced;
				}
				return parentMessages;
			}
		}

		if (fallbackForkTurns && fallbackForkTurns.length > 0) {
			return forkedTurnsToReplayedMessages(fallbackForkTurns);
		}
		return [];
	}

	private async renderReplayedHistory(
		messages: ReplayedMessage[],
		options?: { forkDividerAt?: number },
	): Promise<void> {
		if (!this.messagesEl) return;
		if (messages.length === 0) {
			this.resetEmptyState();
			return;
		}
		this.renderedTurns = [];
		for (let i = 0; i < messages.length; i++) {
			if (options?.forkDividerAt !== undefined && i === options.forkDividerAt) {
				const divider = this.messagesEl.createDiv({
					cls: 'anti-dian-fork-divider',
				});
				const icon = divider.createSpan({ cls: 'anti-dian-fork-divider-icon' });
				setIcon(icon, 'git-fork');
				divider.createSpan({ text: 'Forked into new conversation' });
			}
			const message = messages[i]!;
			if (message.role === 'user') {
				const turn: RenderedTurn = {
					userGroupEl: this.messagesEl.createDiv({
						cls: 'anti-dian-message-user-group is-replayed',
					}),
					userText: message.text,
					historyStartIndex: this.history.length,
				};
				const userMsg = turn.userGroupEl.createDiv({
					cls: 'anti-dian-message anti-dian-message-user is-replayed',
				});
				userMsg.createEl('p', { text: message.text });
				this.renderUserMetaRow(turn.userGroupEl, {
					text: message.text,
					timestamp: message.timestamp,
					onUndo: () => void this.undoFromTurn(turn),
				});
				this.renderedTurns.push(turn);
			} else {
				const agentMsg = this.messagesEl.createDiv({
					cls: 'anti-dian-message anti-dian-message-agent is-replayed',
				});
				const lastTurn = this.renderedTurns[this.renderedTurns.length - 1];
				if (lastTurn && !lastTurn.agentEl) {
					lastTurn.agentEl = agentMsg;
					lastTurn.agentText = message.text;
				}
				if (message.events && message.events.length > 0) {
					this.renderReplayedTrace(agentMsg, message.events, message.durationMs);
				}
				const answerEl = agentMsg.createDiv({ cls: 'anti-dian-answer-body' });
				await MarkdownRenderer.render(this.app, message.text, answerEl, '', this);
				linkifyCodeWikilinks(this.app, answerEl, '');
				this.renderAgentFooterRow(agentMsg, {
					copyText: message.text,
					timestamp: message.timestamp,
					usage: message.usage,
					onFork: lastTurn ? () => void this.forkFromTurn(lastTurn) : undefined,
				});
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
		this.renderedTurns = [];
		this.messagesEl?.empty();
	}

	/** Pick a fresh empty-state greeting (time-of-day aware). */
	private refreshGreeting(): void {
		if (!this.heroTitleEl) return;
		const hour = new Date().getHours();
		const timed =
			hour < 5 ? 'Late night thoughts?'
			: hour < 12 ? 'Good morning. What\'s on your mind?'
			: hour < 18 ? 'Good afternoon. What are we noting?'
			: 'Good evening. Anything to capture?';
		const greetings = [
			timed,
			'What\'s worth writing down?',
			'Capture a thought, grow a note.',
			'What are you thinking about?',
			'Let\'s turn ideas into notes.',
		];
		this.heroTitleEl.setText(greetings[Math.floor(Math.random() * greetings.length)] ?? timed);
	}

	private resetEmptyState(): void {
		this.refreshGreeting();
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

		// Empty-state hero above the prompt bar (hidden once a chat starts).
		const heroEl = this.centerContainerEl.createDiv({ cls: 'anti-dian-empty-hero' });
		heroEl.createEl('img', {
			cls: 'anti-dian-empty-logo',
			attr: { src: logoUrl, alt: '', draggable: 'false' },
		});
		this.heroTitleEl = heroEl.createDiv({ cls: 'anti-dian-empty-title' });
		this.refreshGreeting();

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
		this.pendingForkParent = null;
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

		const sentAtIso = new Date().toISOString();
		const turnRecord: RenderedTurn = {
			userGroupEl: this.messagesEl.createDiv({
				cls: 'anti-dian-message-user-group',
			}),
			userText: text,
			historyStartIndex: this.history.length,
		};
		const userMsg = turnRecord.userGroupEl.createDiv({
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

		this.renderUserMetaRow(turnRecord.userGroupEl, {
			text,
			timestamp: sentAtIso,
			onUndo: () => void this.undoFromTurn(turnRecord),
		});

		this.scrollToBottom();

		const agentMsg = this.messagesEl.createDiv({
			cls: 'anti-dian-message anti-dian-message-agent',
		});
		turnRecord.agentEl = agentMsg;
		this.renderedTurns.push(turnRecord);

		const thinkingState = new ThinkingStateView(agentMsg, this.app, this, {
			hoverParent: this,
			getShowRawToolData: () => this.plugin.settings.showRawToolData ?? false,
			undoChange: async (changeSetId) => {
				await this.plugin.applicator.rollback(changeSetId);
			},
		});
		turnRecord.thinkingState = thinkingState;
		this.activeThinking = thinkingState;
		const answerEl = agentMsg.createDiv({ cls: 'anti-dian-answer-body' });
		let receivedMarkdown = '';
		let streamedMarkdown = '';
		let streamAnimationFrame: number | null = null;
		let streamLastFrame = 0;
		let streamSourceEnded = false;
		let resolveStreamComplete: (() => void) | null = null;
		let answerWaitingForThought = false;
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
		// Shows the latest finished render even if the text has grown since, so slow
		// renders (MathJax for `$…$`) don't freeze the stream until it ends.
		const streamRenderLoop = new StreamRenderLoop<HTMLElement>({
			getText: () => streamedMarkdown,
			schedule: (fn) => window.requestAnimationFrame(() => fn()),
			render: async (markdown) => {
				const rendered = answerEl.createDiv();
				rendered.detach();
				await MarkdownRenderer.render(this.app, markdown, rendered, renderSourcePath, this);
				return rendered;
			},
			show: (rendered) => {
				if (streamingFinished) return;
				linkifyCodeWikilinks(this.app, rendered, renderSourcePath);
				answerEl.replaceChildren(...Array.from(rendered.childNodes));
				appendStreamCaret();
				this.scrollToBottom();
			},
		});
		const renderStreamedMarkdown = () => streamRenderLoop.request();
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
						streamRenderLoop.reset();
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
				streamRenderLoop.reset();
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
				streamRenderLoop.reset();
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

			const finalAnswerText = result.cancelled
				? result.answer || streamedMarkdown.trim()
				: result.answer;
			turnRecord.agentText = finalAnswerText;

			if (result.usage) {
				this.sessionPromptTokens += result.usage.promptTokens;
				this.sessionCandidateTokens += result.usage.candidatesTokens;
				this.sessionTotalTokens += result.usage.totalTokens;
				this.sessionCachedReadTokens += result.usage.cachedReadTokens;
				this.sessionThoughtTokens += result.usage.thoughtTokens;
				this.lastTurnPromptTokens = result.usage.promptTokens;
			}

			this.renderAgentFooterRow(agentMsg, {
				copyText: finalAnswerText,
				timestamp: new Date().toISOString(),
				usage: result.usage,
				onFork: () => void this.forkFromTurn(turnRecord),
			});
		} catch (err) {
			if (myToken !== this.turnToken) return;
			thinkingState.settle();
			streamingFinished = true;
			if (streamAnimationFrame !== null) {
				window.cancelAnimationFrame(streamAnimationFrame);
				streamAnimationFrame = null;
			}
			streamRenderLoop.reset();
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

	private recordPendingForkIfReady(): void {
		const pending = this.pendingForkParent;
		if (!pending) return;
		const childId = this.plugin.antigravityProvider.getSessionId();
		if (!childId || childId === pending.parentId) return;
		this.pendingForkParent = null;
		const forks = { ...(this.plugin.settings.sessionForks ?? {}) };
		forks[childId] = {
			parentId: pending.parentId,
			title: pending.title,
			parentTurnCount: pending.parentTurnCount,
		};
		this.plugin.settings.sessionForks = forks;
		void this.plugin.saveData(this.plugin.settings);
	}

	private formatRelativeTimestamp(iso?: string): string {
		if (!iso) return '';
		const ms = Date.parse(iso);
		if (!Number.isFinite(ms)) return '';
		const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
		if (diffSec < 60) return 'Just now';
		const diffMin = Math.floor(diffSec / 60);
		if (diffMin < 60) return `${diffMin}m ago`;
		const diffHour = Math.floor(diffMin / 60);
		if (diffHour < 24) return `${diffHour}h ago`;
		const diffDay = Math.floor(diffHour / 24);
		return `${diffDay}d ago`;
	}

	private createCopyButton(parent: HTMLElement, textToCopy: string): void {
		const copyBtn = parent.createEl('button', {
			cls: 'anti-dian-msg-action-btn',
			attr: { type: 'button', 'aria-label': 'Copy message' },
		});
		setIcon(copyBtn, 'copy');
		setTooltip(copyBtn, 'Copy message');
		copyBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			void navigator.clipboard
				.writeText(textToCopy)
				.then(() => {
					setIcon(copyBtn, 'check');
					copyBtn.addClass('is-copied');
					window.setTimeout(() => {
						setIcon(copyBtn, 'copy');
						copyBtn.removeClass('is-copied');
					}, 1500);
				})
				.catch(() => {
					new Notice('Could not copy message to clipboard.');
				});
		});
	}

	private renderUserMetaRow(
		parent: HTMLElement,
		opts: {
			text: string;
			timestamp?: string;
			onUndo: () => void;
		},
	): void {
		const row = parent.createDiv({ cls: 'anti-dian-message-meta is-user' });
		const rel = this.formatRelativeTimestamp(opts.timestamp);
		if (rel) {
			const timeEl = row.createSpan({
				cls: 'anti-dian-message-time',
				text: rel,
			});
			if (opts.timestamp) {
				setTooltip(timeEl, new Date(opts.timestamp).toLocaleString());
			}
		}

		if (opts.text.trim()) {
			this.createCopyButton(row, opts.text);
		}

		const undoBtn = row.createEl('button', {
			cls: 'anti-dian-msg-action-btn',
			attr: { type: 'button', 'aria-label': 'Undo to before this message' },
		});
		setIcon(undoBtn, 'undo-2');
		setTooltip(undoBtn, 'Undo to before this message');
		undoBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			opts.onUndo();
		});
	}

	private renderAgentFooterRow(
		parent: HTMLElement,
		opts: {
			copyText?: string;
			timestamp?: string;
			onFork?: () => void;
			usage?: {
				promptTokens: number;
				candidatesTokens: number;
				totalTokens: number;
				cachedReadTokens: number;
				cachedWriteTokens: number;
				thoughtTokens: number;
			};
		},
	): void {
		const hasCopy = Boolean(opts.copyText?.trim());
		const rel = this.formatRelativeTimestamp(opts.timestamp);
		if (!hasCopy && !opts.onFork && !rel && !opts.usage) return;

		const row = parent.createDiv({ cls: 'anti-dian-message-meta is-agent' });
		const left = row.createDiv({ cls: 'anti-dian-message-meta-left' });
		if (hasCopy && opts.copyText) {
			this.createCopyButton(left, opts.copyText);
		}
		if (opts.onFork) {
			const onFork = opts.onFork;
			const forkBtn = left.createEl('button', {
				cls: 'anti-dian-msg-action-btn',
				attr: { type: 'button', 'aria-label': 'Fork conversation from here' },
			});
			setIcon(forkBtn, 'git-fork');
			setTooltip(forkBtn, 'Fork conversation from here');
			forkBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				onFork();
			});
		}
		if (rel) {
			const timeEl = left.createSpan({
				cls: 'anti-dian-message-time',
				text: rel,
			});
			if (opts.timestamp) {
				setTooltip(timeEl, new Date(opts.timestamp).toLocaleString());
			}
		}

		if (opts.usage) {
			this.renderUsageFooter(row, opts.usage);
		}
	}

	/**
	 * Forks a brand-new conversation starting right after `target`'s response,
	 * preserving turns `0..idx` as context while leaving the parent session intact.
	 */
	private async forkFromTurn(target: RenderedTurn): Promise<void> {
		const idx = this.renderedTurns.indexOf(target);
		if (idx === -1) return;

		this.turnToken++;
		if (this.isRunning) {
			this.handleCancel();
			this.isRunning = false;
			this.promptBar?.setRunning(false);
		} else {
			this.activeThinking?.cancelPendingApprovals();
		}

		const keptTurns = this.renderedTurns.slice(0, idx + 1);
		const droppedTurns = this.renderedTurns.slice(idx + 1);
		for (const turn of droppedTurns) {
			turn.userGroupEl.remove();
			turn.agentEl?.remove();
		}
		this.renderedTurns = keptTurns;

		// Remove any previous fork dividers before placing the new branch marker
		this.messagesEl
			?.querySelectorAll('.anti-dian-fork-divider')
			.forEach((el) => el.remove());

		const forkedHistory = keptTurns.map((t) => ({
			userText: t.userText,
			agentText: t.agentText ?? '',
		}));
		this.history = [];
		for (const t of forkedHistory) {
			if (t.userText) this.history.push({ role: 'user', text: t.userText });
			if (t.agentText) {
				this.history.push({ role: 'assistant', text: t.agentText });
			}
		}

		const parentSessionId = this.plugin.antigravityProvider.getSessionId();
		const parentTitle =
			this.plugin.antigravityProvider.getSessionTitle() ?? this.resumedTitle;
		const forkTitle = parentTitle
			? /\(fork\)$/i.test(parentTitle)
				? parentTitle
				: `${parentTitle} (fork)`
			: undefined;
		this.pendingForkParent = parentSessionId
			? {
					parentId: parentSessionId,
					title: forkTitle,
					parentTurnCount: keptTurns.length,
				}
			: null;
		this.resetSessionStats();
		this.resumedTitle = forkTitle ?? null;

		await this.agent.forkSession(forkedHistory);
		this.updateSessionTitle();

		if (this.messagesEl) {
			const divider = this.messagesEl.createDiv({
				cls: 'anti-dian-fork-divider',
			});
			const icon = divider.createSpan({ cls: 'anti-dian-fork-divider-icon' });
			setIcon(icon, 'git-fork');
			divider.createSpan({ text: 'Forked into new conversation' });
		}

		this.promptBar?.focus();
		this.scrollToBottom();
		new Notice('Forked into a new conversation.');
	}

	/**
	 * Rewinds the conversation to just before `target`, rolling back any vault
	 * edits made in `target` and later turns, and puts its prompt back in the
	 * input box for editing.
	 */
	private async undoFromTurn(target: RenderedTurn): Promise<void> {
		const idx = this.renderedTurns.indexOf(target);
		if (idx === -1) return;

		if (this.isRunning) {
			this.handleCancel();
		}

		const affected = this.renderedTurns.slice(idx);
		let revertedCount = 0;
		for (const turn of [...affected].reverse()) {
			if (turn.thinkingState?.hasUndoableChanges()) {
				const reverted = await turn.thinkingState.undoAllApplied();
				if (reverted === 0 && turn.thinkingState.hasUndoableChanges()) {
					// User cancelled confirmation dialog
					return;
				}
				revertedCount += reverted;
			}
		}

		for (const turn of affected) {
			turn.userGroupEl.remove();
			turn.agentEl?.remove();
		}
		this.renderedTurns.splice(idx);
		this.history = this.history.slice(0, target.historyStartIndex);

		if (this.renderedTurns.length === 0) {
			this.resetSessionStats();
			this.resetEmptyState();
		}

		void this.agent.resetSession();
		if (target.userText) {
			this.promptBar.setText(target.userText);
			this.promptBar.focus();
		}
		if (revertedCount > 0) {
			new Notice(
				`Undid turn and reverted ${revertedCount} change${revertedCount === 1 ? '' : 's'}.`,
			);
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
	): HTMLElement {
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
		return footer;
	}

	private scrollToBottom(): void {
		if (this.messagesEl) {
			this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
		}
	}
}
