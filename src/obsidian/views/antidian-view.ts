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
import { PermissionMode } from '../../settings';
import { renderChangeSet } from './changeset-view';
import { ModelMenuController } from './model-menu-view';

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

	private rootEl: HTMLElement | null = null;
	private topNavEl: HTMLElement | null = null;
	private centerContainerEl: HTMLElement | null = null;
	private messagesEl: HTMLElement | null = null;
	private inputCardEl: HTMLElement | null = null;
	private inputEl: HTMLTextAreaElement | null = null;
	private sendButtonEl: HTMLButtonElement | null = null;
	private modelPillLabelEl: HTMLElement | null = null;
	private activeNotePillEl: HTMLElement | null = null;
	private activeNoteLabelEl: HTMLElement | null = null;
	private includeActiveNote = true;

	private availableModels: AvailableModel[] = [];
	private modelGroups: ModelGroup[] = [];
	private history: Message[] = [];
	private stagedMedia: MediaInput[] = [];
	private mediaTrayEl: HTMLElement | null = null;
	private fileInputEl: HTMLInputElement | null = null;
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
		this.updateActiveNotePill(context);
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

		this.inputCardEl = this.centerContainerEl.createDiv({
			cls: 'anti-dian-input-card',
		});

		this.mediaTrayEl = this.inputCardEl.createDiv({
			cls: 'anti-dian-media-tray anti-dian-hidden',
		});

		this.inputEl = this.inputCardEl.createEl('textarea', {
			cls: 'anti-dian-input-textarea',
			attr: {
				placeholder: 'Ask anything, @ to mention, / for actions',
				rows: '3',
			},
		});

		this.inputEl.addEventListener('keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				void this.handleSend();
			}
		});

		this.inputEl.addEventListener('paste', (event: ClipboardEvent) => {
			const items = event.clipboardData?.items;
			if (!items) return;
			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if (item && item.kind === 'file' && item.type.startsWith('image/')) {
					const file = item.getAsFile();
					if (file) {
						event.preventDefault();
						void this.addMediaFile(file);
					}
				}
			}
		});

		const toolbar = this.inputCardEl.createDiv({
			cls: 'anti-dian-input-toolbar',
		});

		const leftControls = toolbar.createDiv({
			cls: 'anti-dian-input-left-controls',
		});

		this.fileInputEl = this.inputCardEl.createEl('input', {
			attr: {
				type: 'file',
				accept: 'image/*,video/*,audio/*',
				multiple: 'true',
				style: 'display: none;',
			},
		});
		this.fileInputEl.onchange = () => {
			if (this.fileInputEl?.files) {
				for (let i = 0; i < this.fileInputEl.files.length; i++) {
					const file = this.fileInputEl.files[i];
					if (file) void this.addMediaFile(file);
				}
				this.fileInputEl.value = '';
			}
		};

		const attachBtn = leftControls.createEl('button', {
			cls: 'anti-dian-btn-attach',
			attr: { 'aria-label': 'Add file or image' },
		});
		setIcon(attachBtn, 'plus');
		attachBtn.onclick = (e) => {
			e.stopPropagation();
			this.fileInputEl?.click();
		};

		const modelPill = leftControls.createDiv({
			cls: 'anti-dian-model-pill',
		});
		this.modelPillLabelEl = modelPill.createSpan({
			cls: 'anti-dian-model-pill-label',
			text: this.modelMenuController.formatModelLabel(),
		});
		const pillChevron = modelPill.createSpan({
			cls: 'anti-dian-model-pill-chevron',
		});
		setIcon(pillChevron, 'chevron-down');

		modelPill.onclick = (e) => {
			e.stopPropagation();
			this.modelMenuController.toggleMenu(modelPill);
		};

		this.activeNotePillEl = leftControls.createDiv({
			cls: 'anti-dian-active-note-pill',
			attr: { 'aria-label': 'Toggle active note context' },
		});
		const noteIcon = this.activeNotePillEl.createSpan({
			cls: 'anti-dian-active-note-icon',
		});
		setIcon(noteIcon, 'file-text');

		this.activeNoteLabelEl = this.activeNotePillEl.createSpan({
			cls: 'anti-dian-active-note-label',
			text: this.getCurrentActiveNoteName(),
		});

		this.activeNotePillEl.onclick = (e) => {
			e.stopPropagation();
			this.toggleActiveNoteContext();
		};

		this.updateActiveNotePill();

		const rightControls = toolbar.createDiv({
			cls: 'anti-dian-input-right-controls',
		});

		const permSelect = rightControls.createEl('select', {
			cls: 'anti-dian-input-perm-select',
			attr: { 'aria-label': 'Permission mode' },
		});
		permSelect.createEl('option', { text: 'Ask', value: 'ask' });
		permSelect.createEl('option', { text: 'Plan', value: 'plan' });
		permSelect.createEl('option', { text: 'Auto', value: 'auto' });
		permSelect.value = this.plugin.settings.permissionMode ?? 'ask';
		permSelect.onchange = () => {
			const val = permSelect.value as PermissionMode;
			if (val) {
				this.plugin.settings.permissionMode = val;
				void this.plugin.saveSettings();
			}
		};

		this.sendButtonEl = rightControls.createEl('button', {
			cls: 'anti-dian-btn-send',
			attr: { 'aria-label': 'Send message' },
		});
		setIcon(this.sendButtonEl, 'arrow-right');
		this.sendButtonEl.onclick = () => {
			void this.handleSend();
		};
	}

	private getCurrentActiveNoteName(): string {
		const ctx = this.contextService.getActiveContext();
		if (!ctx.activeFile) return 'No note';
		return (
			ctx.activeFile.replace(/\.md$/, '').split('/').pop() || 'No note'
		);
	}

	private toggleActiveNoteContext(): void {
		const ctx = this.contextService.getActiveContext();
		if (!ctx.activeFile) return;
		this.includeActiveNote = !this.includeActiveNote;
		this.updateActiveNotePill(ctx);
	}

	private updateActiveNotePill(context?: ActiveContext): void {
		if (!this.activeNotePillEl || !this.activeNoteLabelEl) return;
		const ctx = context ?? this.contextService.getActiveContext();
		const hasNote = Boolean(ctx.activeFile);
		const noteName = hasNote
			? ctx.activeFile?.replace(/\.md$/, '').split('/').pop() || 'Untitled'
			: 'No note';

		this.activeNoteLabelEl.setText(noteName);

		if (!hasNote) {
			this.activeNotePillEl.addClass('is-empty');
			this.activeNotePillEl.removeClass('is-active');
			this.activeNotePillEl.removeClass('is-inactive');
			this.activeNotePillEl.setAttribute(
				'aria-label',
				'No active note opened',
			);
			return;
		}

		this.activeNotePillEl.removeClass('is-empty');

		if (this.includeActiveNote) {
			this.activeNotePillEl.addClass('is-active');
			this.activeNotePillEl.removeClass('is-inactive');
			this.activeNotePillEl.setAttribute(
				'aria-label',
				'Active note included in context (click to exclude)',
			);
		} else {
			this.activeNotePillEl.addClass('is-inactive');
			this.activeNotePillEl.removeClass('is-active');
			this.activeNotePillEl.setAttribute(
				'aria-label',
				'Active note excluded from context (click to include)',
			);
		}
	}

	private selectModel(modelId: string): void {
		this.plugin.settings.model = modelId;
		this.plugin.geminiProvider.setModel(modelId);
		void this.plugin.saveSettings();

		if (this.modelPillLabelEl) {
			this.modelPillLabelEl.setText(
				this.modelMenuController.formatModelLabel(modelId),
			);
		}
	}

	private startNewSession(): void {
		this.history = [];
		this.stagedMedia = [];
		this.renderMediaTray();
		if (this.messagesEl) {
			this.messagesEl.empty();
		}
		if (this.rootEl) {
			this.rootEl.removeClass('has-chat');
			this.rootEl.addClass('is-empty-session');
		}
		if (this.inputEl) {
			this.inputEl.value = '';
			this.inputEl.focus();
		}
	}

	private async addMediaFile(file: File): Promise<void> {
		const data = await new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result as string);
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});

		const type: MediaInput['type'] = file.type.startsWith('video/')
			? 'video'
			: file.type.startsWith('audio/')
				? 'audio'
				: 'image';

		this.stagedMedia.push({
			type,
			mimeType: file.type || (type === 'image' ? 'image/png' : 'video/mp4'),
			data,
		});

		this.renderMediaTray();
	}

	private renderMediaTray(): void {
		if (!this.mediaTrayEl) return;
		this.mediaTrayEl.empty();
		if (this.stagedMedia.length === 0) {
			this.mediaTrayEl.addClass('anti-dian-hidden');
			return;
		}
		this.mediaTrayEl.removeClass('anti-dian-hidden');

		for (let i = 0; i < this.stagedMedia.length; i++) {
			const item = this.stagedMedia[i];
			if (!item) continue;
			const chip = this.mediaTrayEl.createDiv({
				cls: 'anti-dian-media-chip',
			});

			if (item.type === 'image' && item.data) {
				chip.createEl('img', {
					cls: 'anti-dian-media-chip-thumb',
					attr: { src: item.data },
				});
			} else {
				const iconSpan = chip.createSpan({
					cls: 'anti-dian-media-chip-icon',
				});
				setIcon(iconSpan, item.type === 'video' ? 'video' : 'file');
				chip.createSpan({
					text: item.type,
					cls: 'anti-dian-media-chip-label',
				});
			}

			const removeBtn = chip.createEl('button', {
				cls: 'anti-dian-media-chip-remove',
				text: '×',
			});
			const idx = i;
			removeBtn.onclick = (e) => {
				e.stopPropagation();
				this.stagedMedia.splice(idx, 1);
				this.renderMediaTray();
			};
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
			if (this.modelPillLabelEl) {
				this.modelPillLabelEl.setText(
					this.modelMenuController.formatModelLabel(),
				);
			}
		} catch {
			// Fallback defaults
		}
	}

	private async handleSend(): Promise<void> {
		if (!this.inputEl || !this.messagesEl || this.isRunning) {
			return;
		}

		const text = this.inputEl.value.trim();
		const mediaToSend = [...this.stagedMedia];
		if (!text && mediaToSend.length === 0) {
			return;
		}

		this.stagedMedia = [];
		this.renderMediaTray();

		this.isRunning = true;
		if (this.sendButtonEl) {
			this.sendButtonEl.disabled = true;
		}

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

		this.inputEl.value = '';
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
			const activeCtx: ActiveContext = this.includeActiveNote
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
			if (this.sendButtonEl) {
				this.sendButtonEl.disabled = false;
			}
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
