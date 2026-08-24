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
import { ChangeSet } from '../../core/types/changes';
import { ChangeSetValidator } from '../../core/transactions';
import {
	fetchAvailableModels,
	fetchUserQuota,
	formatTokens,
	groupModels,
	AvailableModel,
	ModelGroup,
} from '../../core/models/antigravity-oauth';
import { PermissionMode } from '../../settings';

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
	private modelMenuEl: HTMLElement | null = null;
	private effortSubmenuEl: HTMLElement | null = null;
	private usageSubmenuEl: HTMLElement | null = null;

	private availableModels: AvailableModel[] = [];
	private modelGroups: ModelGroup[] = [];
	private history: Message[] = [];
	private stagedMedia: MediaInput[] = [];
	private mediaTrayEl: HTMLElement | null = null;
	private fileInputEl: HTMLInputElement | null = null;
	private isRunning = false;
	private isModelMenuOpen = false;
	private isUsageSubmenuOpen = false;

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

		// Click outside to close model menus and submenus
		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			const target = evt.target as HTMLElement;
			if (
				this.isModelMenuOpen &&
				!target.closest('.anti-dian-model-pill') &&
				!target.closest('.anti-dian-model-menu') &&
				!target.closest('.anti-dian-effort-popup') &&
				!target.closest('.anti-dian-usage-popup')
			) {
				this.closeModelMenu();
			}
		});

		void this.loadModels();
	}

	async onClose(): Promise<void> {
		if (this.unsubscribeContext) {
			this.unsubscribeContext();
			this.unsubscribeContext = null;
		}
		this.closeModelMenu();
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

		// Permission Mode badge/picker
		const permSelect = rightGroup.createEl('select', {
			cls: 'anti-dian-nav-perm-select',
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

		// New Session / Clear button
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

		// 1. Media attachment tray
		this.mediaTrayEl = this.inputCardEl.createDiv({
			cls: 'anti-dian-media-tray anti-dian-hidden',
		});

		// 2. Textarea
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

		// Paste image / media from clipboard
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

		// 3. Toolbar inside input card
		const toolbar = this.inputCardEl.createDiv({
			cls: 'anti-dian-input-toolbar',
		});

		const leftControls = toolbar.createDiv({
			cls: 'anti-dian-input-left-controls',
		});

		// Hidden file picker input
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

		// Attach / Context button
		const attachBtn = leftControls.createEl('button', {
			cls: 'anti-dian-btn-attach',
			attr: { 'aria-label': 'Add file or image' },
		});
		setIcon(attachBtn, 'plus');
		attachBtn.onclick = (e) => {
			e.stopPropagation();
			this.fileInputEl?.click();
		};

		// Model selector pill
		const modelPill = leftControls.createDiv({
			cls: 'anti-dian-model-pill',
		});
		this.modelPillLabelEl = modelPill.createSpan({
			cls: 'anti-dian-model-pill-label',
			text: this.formatCurrentModelPillLabel(),
		});
		const pillChevron = modelPill.createSpan({
			cls: 'anti-dian-model-pill-chevron',
		});
		setIcon(pillChevron, 'chevron-down');

		modelPill.onclick = (e) => {
			e.stopPropagation();
			this.toggleModelMenu(modelPill);
		};

		// Active note toggle pill
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

		// Send button
		this.sendButtonEl = toolbar.createEl('button', {
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

	private formatCurrentModelPillLabel(): string {
		const currentId =
			this.plugin.settings.model || 'gemini-3.7-flash-high';

		const group = this.modelGroups.find((g) =>
			g.variants.some((v) => v.id === currentId),
		);

		if (group) {
			const variant = group.variants.find((v) => v.id === currentId);
			const effort = variant?.thinkingEffort;
			if (effort && effort !== 'Default') {
				return `${group.baseName} ${effort}`;
			}
			return group.baseName;
		}

		if (currentId.startsWith('gemini-3.7-flash')) {
			const effort = currentId.includes('high')
				? 'High'
				: currentId.includes('low')
					? 'Low'
					: 'Medium';
			return `Gemini 3.7 Flash ${effort}`;
		}
		if (currentId.startsWith('gemini-3.6-flash')) {
			const effort = currentId.includes('high')
				? 'High'
				: currentId.includes('low')
					? 'Low'
					: 'Medium';
			return `Gemini 3.6 Flash ${effort}`;
		}
		if (currentId.startsWith('gemini-3.5-flash')) {
			const effort = currentId.includes('low') ? 'Low' : 'Medium';
			return `Gemini 3.5 Flash ${effort}`;
		}
		if (currentId.startsWith('gemini-3.1-pro')) {
			return 'Gemini 3.1 Pro Low';
		}
		if (currentId.includes('claude-sonnet')) {
			return 'Claude Sonnet 4.6';
		}
		if (currentId.includes('claude-opus')) {
			return 'Claude Opus 4.6';
		}
		if (currentId.includes('gpt-oss')) {
			return 'GPT-OSS 120B';
		}

		return currentId;
	}

	private toggleModelMenu(anchorEl: HTMLElement): void {
		if (this.isModelMenuOpen) {
			this.closeModelMenu();
		} else {
			this.openModelMenu(anchorEl);
		}
	}

	private openModelMenu(anchorEl: HTMLElement): void {
		this.closeModelMenu();
		this.isModelMenuOpen = true;

		this.modelMenuEl = document.body.createDiv({
			cls: 'anti-dian-model-menu',
		});

		this.modelMenuEl.createDiv({
			cls: 'anti-dian-menu-header',
			text: 'Model',
		});

		const currentModelId =
			this.plugin.settings.model || 'gemini-3.7-flash-high';

		const groups =
			this.modelGroups.length > 0
				? this.modelGroups
				: groupModels(this.availableModels);

		const listContainer = this.modelMenuEl.createDiv({
			cls: 'anti-dian-menu-list',
		});

		for (const group of groups) {
			const isGroupActive = group.variants.some(
				(v) => v.id === currentModelId,
			);
			const hasMultipleEfforts = group.variants.length > 1;

			const item = listContainer.createDiv({
				cls: `anti-dian-menu-item ${isGroupActive ? 'is-selected' : ''}`,
			});

			const itemLeft = item.createDiv({ cls: 'anti-dian-menu-item-left' });
			itemLeft.createSpan({
				text: group.baseName,
				cls: 'anti-dian-menu-item-title',
			});

			// Active effort label if single or selected
			const activeVariant = group.variants.find(
				(v) => v.id === currentModelId,
			);
			if (activeVariant && activeVariant.thinkingEffort !== 'Default') {
				itemLeft.createSpan({
					text: activeVariant.thinkingEffort,
					cls: 'anti-dian-menu-item-effort',
				});
			} else if (!hasMultipleEfforts && group.supportsThinking) {
				itemLeft.createSpan({
					text: 'Thinking',
					cls: 'anti-dian-menu-item-effort',
				});
			}

			if (group.baseName.includes('3.6') || group.baseName.includes('3.5')) {
				const badge = itemLeft.createSpan({
					cls: 'anti-dian-menu-item-badge',
				});
				badge.setText('Fast');
				const infoIcon = badge.createSpan({
					cls: 'anti-dian-menu-info-icon',
				});
				setIcon(infoIcon, 'info');
			}

			const itemRight = item.createDiv({
				cls: 'anti-dian-menu-item-right',
			});

			if (hasMultipleEfforts) {
				const chev = itemRight.createSpan({
					cls: 'anti-dian-menu-chev',
				});
				setIcon(chev, 'chevron-right');

				// Open effort submenu on hover or click
				item.onmouseenter = () => {
					this.closeUsageSubmenu();
					this.openEffortSubmenu(item, group);
				};

				item.onclick = (e) => {
					e.stopPropagation();
					this.openEffortSubmenu(item, group);
				};
			} else {
				if (isGroupActive) {
					const check = itemRight.createSpan({
						cls: 'anti-dian-menu-check',
					});
					setIcon(check, 'check');
				}

				item.onmouseenter = () => {
					this.closeEffortSubmenu();
				};

				item.onclick = (e) => {
					e.stopPropagation();
					if (group.variants[0]) {
						this.selectModel(group.variants[0].id);
					}
				};
			}
		}

		// Divider
		this.modelMenuEl.createDiv({ cls: 'anti-dian-menu-divider' });

		// View Usage
		const usageItem = this.modelMenuEl.createDiv({
			cls: 'anti-dian-menu-item anti-dian-menu-item-usage',
		});
		const usageLeft = usageItem.createDiv({
			cls: 'anti-dian-menu-item-left',
		});
		const usageIcon = usageLeft.createSpan({
			cls: 'anti-dian-usage-icon-indicator',
		});
		setIcon(usageIcon, 'activity');
		usageLeft.createSpan({
			text: 'View Usage',
			cls: 'anti-dian-menu-item-title',
		});

		const usageRight = usageItem.createDiv({
			cls: 'anti-dian-menu-item-right',
		});
		const usageChev = usageRight.createSpan({
			cls: 'anti-dian-menu-chev',
		});
		setIcon(usageChev, 'chevron-right');

		usageItem.onmouseenter = () => {
			this.closeEffortSubmenu();
			void this.openUsageSubmenu(usageItem);
		};

		usageItem.onclick = (e) => {
			e.stopPropagation();
			this.toggleUsageSubmenu(usageItem);
		};

		// Position menu relative to pill
		this.positionMenu(anchorEl, this.modelMenuEl);
	}

	private openEffortSubmenu(anchorEl: HTMLElement, group: ModelGroup): void {
		this.closeEffortSubmenu();

		this.effortSubmenuEl = document.body.createDiv({
			cls: 'anti-dian-effort-popup',
		});

		const currentModelId =
			this.plugin.settings.model || 'gemini-3.7-flash-high';

		this.effortSubmenuEl.createDiv({
			cls: 'anti-dian-menu-header',
			text: 'Thinking Effort',
		});

		for (const variant of group.variants) {
			const isSelected = currentModelId === variant.id;

			const item = this.effortSubmenuEl.createDiv({
				cls: `anti-dian-menu-item ${isSelected ? 'is-selected' : ''}`,
			});

			const itemLeft = item.createDiv({ cls: 'anti-dian-menu-item-left' });
			itemLeft.createSpan({
				text: variant.thinkingEffort,
				cls: 'anti-dian-menu-item-title',
			});

			const itemRight = item.createDiv({
				cls: 'anti-dian-menu-item-right',
			});
			if (isSelected) {
				const check = itemRight.createSpan({
					cls: 'anti-dian-menu-check',
				});
				setIcon(check, 'check');
			}

			item.onclick = (e) => {
				e.stopPropagation();
				this.selectModel(variant.id);
			};
		}

		this.positionSubmenu(anchorEl, this.effortSubmenuEl);
	}

	private closeEffortSubmenu(): void {
		if (this.effortSubmenuEl) {
			this.effortSubmenuEl.remove();
			this.effortSubmenuEl = null;
		}
	}

	private positionMenu(anchor: HTMLElement, menu: HTMLElement): void {
		const anchorRect = anchor.getBoundingClientRect();
		const menuHeight = menu.offsetHeight || 380;
		const menuWidth = menu.offsetWidth || 260;
		const viewportHeight = window.innerHeight;
		const viewportWidth = window.innerWidth;

		const spaceBelow = viewportHeight - anchorRect.bottom - 10;
		const spaceAbove = anchorRect.top - 10;

		let top = anchorRect.bottom + 6;
		if (spaceBelow < menuHeight && spaceAbove > spaceBelow) {
			top = Math.max(10, anchorRect.top - menuHeight - 6);
		}

		let left = anchorRect.left;
		if (left + menuWidth > viewportWidth - 10) {
			left = Math.max(10, viewportWidth - menuWidth - 10);
		}

		menu.setCssProps({
			left: `${left}px`,
			top: `${top}px`,
		});
	}

	private positionSubmenu(anchor: HTMLElement, submenu: HTMLElement): void {
		const anchorRect = anchor.getBoundingClientRect();
		const popupHeight = submenu.offsetHeight || 260;
		const popupWidth = submenu.offsetWidth || 250;
		const viewportHeight = window.innerHeight;
		const viewportWidth = window.innerWidth;

		let left = anchorRect.right + 6;
		if (left + popupWidth > viewportWidth - 10) {
			left = Math.max(10, anchorRect.left - popupWidth - 6);
		}

		let top = anchorRect.top;
		if (top + popupHeight > viewportHeight - 10) {
			top = Math.max(10, viewportHeight - popupHeight - 10);
		}

		submenu.setCssProps({
			left: `${left}px`,
			top: `${top}px`,
		});
	}

	private toggleUsageSubmenu(anchorEl: HTMLElement): void {
		if (this.isUsageSubmenuOpen) {
			this.closeUsageSubmenu();
		} else {
			void this.openUsageSubmenu(anchorEl);
		}
	}

	private async openUsageSubmenu(anchorEl: HTMLElement): Promise<void> {
		this.closeUsageSubmenu();
		this.closeEffortSubmenu();
		this.isUsageSubmenuOpen = true;

		this.usageSubmenuEl = document.body.createDiv({
			cls: 'anti-dian-usage-popup',
		});

		this.positionSubmenu(anchorEl, this.usageSubmenuEl);

		const loadingSec = this.usageSubmenuEl.createDiv({
			cls: 'anti-dian-usage-section',
		});
		loadingSec.createDiv({
			text: 'Loading quota limits...',
			cls: 'anti-dian-usage-limit-subtext',
		});

		const quotaData = await fetchUserQuota();
		if (!this.usageSubmenuEl || !this.isUsageSubmenuOpen) return;
		this.usageSubmenuEl.empty();

		const buckets = quotaData?.buckets || [];
		const geminiBucket =
			buckets.find((b) => b.modelId.startsWith('gemini-3.7-flash')) ||
			buckets.find((b) => b.modelId.startsWith('gemini'));
		const claudeBucket = buckets.find((b) =>
			b.modelId.startsWith('claude'),
		);
		const gptBucket = buckets.find((b) => b.modelId.startsWith('gpt'));

		const geminiRemainingPct = geminiBucket
			? `${Math.round(geminiBucket.remainingFraction * 100)}%`
			: '81%';
		const geminiStatus =
			(geminiBucket?.remainingFraction ?? 0.81) < 0.3
				? 'warning'
				: 'success';

		const claudeRemainingPct = claudeBucket
			? `${Math.round(claudeBucket.remainingFraction * 100)}%`
			: '100%';
		const gptRemainingPct = gptBucket
			? `${Math.round(gptBucket.remainingFraction * 100)}%`
			: '100%';

		// 1. Gemini Models section
		const geminiSec = this.usageSubmenuEl.createDiv({
			cls: 'anti-dian-usage-section',
		});
		geminiSec.createDiv({
			text: 'Gemini Models',
			cls: 'anti-dian-usage-sec-title',
		});

		this.renderUsageLimitRow(
			geminiSec,
			'Weekly Limit Remaining',
			geminiRemainingPct,
			geminiBucket?.resetTime
				? `Resets ${new Date(geminiBucket.resetTime).toLocaleDateString()}`
				: 'Rolling weekly limit',
			geminiStatus,
		);
		this.renderUsageLimitRow(
			geminiSec,
			'Five Hour Limit Remaining',
			geminiRemainingPct,
			'Short rolling window',
			geminiStatus,
		);

		// Divider
		this.usageSubmenuEl.createDiv({ cls: 'anti-dian-menu-divider' });

		// 2. Claude and GPT models section
		const claudeSec = this.usageSubmenuEl.createDiv({
			cls: 'anti-dian-usage-section',
		});
		claudeSec.createDiv({
			text: 'Claude and GPT models',
			cls: 'anti-dian-usage-sec-title',
		});

		this.renderUsageLimitRow(
			claudeSec,
			'Weekly Limit Remaining',
			claudeRemainingPct,
			undefined,
			'success',
		);
		this.renderUsageLimitRow(
			claudeSec,
			'Five Hour Limit Remaining',
			gptRemainingPct,
			undefined,
			'success',
		);

		// Divider
		this.usageSubmenuEl.createDiv({ cls: 'anti-dian-menu-divider' });

		// 3. Live Session Tokens
		const sessionSec = this.usageSubmenuEl.createDiv({
			cls: 'anti-dian-usage-section',
		});
		sessionSec.createDiv({
			text: 'Session Token Usage (Live)',
			cls: 'anti-dian-usage-sec-title',
		});

		this.renderUsageLimitRow(
			sessionSec,
			'Session Tokens Processed',
			this.sessionTotalTokens.toLocaleString(),
			`${this.sessionPromptTokens.toLocaleString()} in / ${this.sessionCandidateTokens.toLocaleString()} out`,
			'success',
		);

		// Re-adjust position after content height renders
		this.positionSubmenu(anchorEl, this.usageSubmenuEl);
	}

	private renderUsageLimitRow(
		parent: HTMLElement,
		title: string,
		percentage: string,
		subtext?: string,
		status: 'success' | 'warning' | 'error' = 'success',
	): void {
		const row = parent.createDiv({ cls: 'anti-dian-usage-limit-row' });
		const textCol = row.createDiv({ cls: 'anti-dian-usage-text-col' });
		textCol.createDiv({
			text: title,
			cls: 'anti-dian-usage-limit-title',
		});
		if (subtext) {
			textCol.createDiv({
				text: subtext,
				cls: 'anti-dian-usage-limit-subtext',
			});
		}

		const rightCol = row.createDiv({ cls: 'anti-dian-usage-right-col' });
		rightCol.createSpan({
			text: percentage,
			cls: 'anti-dian-usage-pct',
		});
		rightCol.createSpan({
			cls: `anti-dian-usage-ring ring-${status}`,
		});
	}

	private closeUsageSubmenu(): void {
		if (this.usageSubmenuEl) {
			this.usageSubmenuEl.remove();
			this.usageSubmenuEl = null;
		}
		this.isUsageSubmenuOpen = false;
	}

	private closeModelMenu(): void {
		this.closeEffortSubmenu();
		this.closeUsageSubmenu();
		if (this.modelMenuEl) {
			this.modelMenuEl.remove();
			this.modelMenuEl = null;
		}
		this.isModelMenuOpen = false;
	}

	private selectModel(modelId: string): void {
		this.plugin.settings.model = modelId;
		this.plugin.geminiProvider.setModel(modelId);
		void this.plugin.saveSettings();

		if (this.modelPillLabelEl) {
			this.modelPillLabelEl.setText(this.formatCurrentModelPillLabel());
		}

		this.closeModelMenu();
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
					this.formatCurrentModelPillLabel(),
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

		// Switch layout to chat mode (input docks to bottom)
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
				await this.renderChangeSet(agentMsg, result.changeSet);
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

	private async renderChangeSet(
		parent: HTMLElement,
		changeSet: ChangeSet,
	): Promise<void> {
		const card = parent.createDiv({ cls: 'anti-dian-changeset-card' });

		const header = card.createDiv({ cls: 'anti-dian-changeset-header' });
		header.createSpan({
			text: 'Proposed changes',
			cls: 'anti-dian-changeset-title',
		});

		const badge = header.createSpan({
			cls: 'anti-dian-changeset-badge',
		});

		let validation = { valid: true, errors: [] as { code: string; message: string }[] };
		if (this.validator) {
			const valRes = await this.validator.validate(changeSet);
			validation = {
				valid: valRes.valid,
				errors: valRes.errors.map((e) => ({
					code: e.code,
					message: e.message,
				})),
			};
		}

		if (validation.valid) {
			badge.setText('Validated');
			badge.addClass('anti-dian-badge-valid');
		} else {
			badge.setText('Invalid');
			badge.addClass('anti-dian-badge-invalid');
		}

		if (!validation.valid && validation.errors.length > 0) {
			const errList = card.createDiv({
				cls: 'anti-dian-changeset-errors',
			});
			for (const err of validation.errors) {
				errList.createDiv({
					text: `[${err.code}] ${err.message}`,
					cls: 'anti-dian-changeset-error-item',
				});
			}
		}

		let diff = null;
		try {
			diff = await this.plugin.diffGenerator.generate(changeSet);
		} catch {
			// fallback
		}

		const opsList = card.createDiv({ cls: 'anti-dian-changeset-ops-list' });

		for (const op of changeSet.operations) {
			const opItem = opsList.createDiv({
				cls: 'anti-dian-changeset-op-item',
			});

			const isCreate = op.type === 'create';
			opItem.createSpan({
				text: isCreate ? '+' : '~',
				cls: `anti-dian-op-prefix anti-dian-op-${isCreate ? 'create' : 'patch'}`,
			});

			opItem.createSpan({
				text: op.path,
				cls: 'anti-dian-op-path',
			});

			const fileDiff = diff?.files.find((f) => f.path === op.path);
			if (fileDiff) {
				const counts = opItem.createSpan({
					cls: 'anti-dian-op-diff-counts',
				});
				if (fileDiff.additions > 0) {
					counts.createSpan({
						text: `+${fileDiff.additions}`,
						cls: 'anti-dian-diff-count-add',
					});
				}
				if (fileDiff.deletions > 0) {
					counts.createSpan({
						text: `-${fileDiff.deletions}`,
						cls: 'anti-dian-diff-count-del',
					});
				}
			}

			const singleDiffBox = card.createDiv({
				cls: 'anti-dian-single-file-diff anti-dian-hidden',
			});
			if (fileDiff) {
				this.renderFileDiffContent(singleDiffBox, fileDiff);
			}

			opItem.onclick = () => {
				const isHidden = singleDiffBox.hasClass('anti-dian-hidden');
				if (isHidden) {
					singleDiffBox.removeClass('anti-dian-hidden');
					opItem.addClass('is-selected');
				} else {
					singleDiffBox.addClass('anti-dian-hidden');
					opItem.removeClass('is-selected');
				}
			};
		}

		const diffContainer = card.createDiv({
			cls: 'anti-dian-full-diff-container anti-dian-hidden',
		});
		if (diff) {
			this.renderDiffPreview(diffContainer, diff);
		}

		const reviewBtnRow = card.createDiv({
			cls: 'anti-dian-review-btn-row',
		});
		const reviewBtn = reviewBtnRow.createEl('button', {
			text: 'Review changes',
			cls: 'anti-dian-btn-review',
		});
		reviewBtn.onclick = () => {
			if (diffContainer.hasClass('anti-dian-hidden')) {
				diffContainer.removeClass('anti-dian-hidden');
				reviewBtn.setText('Hide review');
			} else {
				diffContainer.addClass('anti-dian-hidden');
				reviewBtn.setText('Review changes');
			}
		};

		const mode = this.plugin.settings.permissionMode ?? 'ask';

		if (mode === 'plan') {
			badge.setText('Plan only');
			badge.className = 'anti-dian-changeset-badge anti-dian-badge-valid';
			const planNotice = card.createDiv({
				cls: 'anti-dian-changeset-result-notice anti-dian-notice-plan',
			});
			planNotice.setText('Plan mode: mutations are not applied to vault');
		} else if (mode === 'auto' && validation.valid) {
			try {
				const applied = await this.plugin.applicator.apply(changeSet);
				badge.setText('Auto-applied');
				badge.className =
					'anti-dian-changeset-badge anti-dian-badge-valid';
				const resultNotice = card.createDiv({
					cls: 'anti-dian-changeset-result-notice anti-dian-notice-applied',
				});
				resultNotice.createSpan({
					text: `Auto-applied ${applied.operations.length} ${applied.operations.length === 1 ? 'change' : 'changes'}`,
					cls: 'anti-dian-notice-msg',
				});

				const undoBtn = resultNotice.createEl('button', {
					text: 'Undo',
					cls: 'anti-dian-btn-undo',
				});

				undoBtn.onclick = async () => {
					undoBtn.disabled = true;
					undoBtn.setText('Undoing...');
					try {
						const rollbackRes =
							await this.plugin.applicator.rollback(changeSet.id);
						badge.setText('Rolled back');
						badge.className =
							'anti-dian-changeset-badge anti-dian-badge-invalid';
						resultNotice.className =
							'anti-dian-changeset-result-notice anti-dian-notice-rejected';
						resultNotice.empty();
						resultNotice.setText(
							`Undid ${rollbackRes.restoredCount} ${rollbackRes.restoredCount === 1 ? 'change' : 'changes'}`,
						);
					} catch (undoErr) {
						undoBtn.disabled = false;
						undoBtn.setText('Undo');
						const errEl = card.createDiv({
							cls: 'anti-dian-changeset-errors',
						});
						errEl.createDiv({
							text: `Notice: ${undoErr instanceof Error ? undoErr.message : String(undoErr)}`,
							cls: 'anti-dian-changeset-error-item',
						});
					}
				};
			} catch (autoErr) {
				const errEl = card.createDiv({
					cls: 'anti-dian-changeset-errors',
				});
				errEl.createDiv({
					text: `Notice: Auto-apply failed: ${autoErr instanceof Error ? autoErr.message : String(autoErr)}`,
					cls: 'anti-dian-changeset-error-item',
				});
			}
		} else {
			const actionsRow = card.createDiv({
				cls: 'anti-dian-changeset-actions-row',
			});

			const rejectBtn = actionsRow.createEl('button', {
				text: 'Reject',
				cls: 'anti-dian-btn-reject',
			});

			const applyBtn = actionsRow.createEl('button', {
				text: 'Apply',
				cls: 'anti-dian-btn-apply mod-cta',
			});

			const resultNotice = card.createDiv({
				cls: 'anti-dian-changeset-result-notice anti-dian-hidden',
			});

			rejectBtn.onclick = () => {
				this.plugin.stagingManager.setStatus(changeSet.id, 'rejected');
				badge.setText('Rejected');
				badge.className =
					'anti-dian-changeset-badge anti-dian-badge-invalid';
				actionsRow.addClass('anti-dian-hidden');
				reviewBtnRow.addClass('anti-dian-hidden');
				resultNotice.removeClass('anti-dian-hidden');
				resultNotice.setText('Changes rejected');
				resultNotice.className =
					'anti-dian-changeset-result-notice anti-dian-notice-rejected';
			};

			applyBtn.onclick = async () => {
				applyBtn.disabled = true;
				rejectBtn.disabled = true;
				applyBtn.setText('Applying...');

				try {
					const applied =
						await this.plugin.applicator.apply(changeSet);
					badge.setText('Applied');
					badge.className =
						'anti-dian-changeset-badge anti-dian-badge-valid';
					actionsRow.addClass('anti-dian-hidden');
					reviewBtnRow.addClass('anti-dian-hidden');
					resultNotice.removeClass('anti-dian-hidden');
					resultNotice.empty();

					resultNotice.createSpan({
						text: `Applied ${applied.operations.length} ${applied.operations.length === 1 ? 'change' : 'changes'}`,
						cls: 'anti-dian-notice-msg',
					});

					const undoBtn = resultNotice.createEl('button', {
						text: 'Undo',
						cls: 'anti-dian-btn-undo',
					});

					undoBtn.onclick = async () => {
						undoBtn.disabled = true;
						undoBtn.setText('Undoing...');
						try {
							const rollbackRes =
								await this.plugin.applicator.rollback(
									changeSet.id,
								);
							badge.setText('Rolled back');
							badge.className =
								'anti-dian-changeset-badge anti-dian-badge-invalid';
							resultNotice.className =
								'anti-dian-changeset-result-notice anti-dian-notice-rejected';
							resultNotice.empty();
							resultNotice.setText(
								`Undid ${rollbackRes.restoredCount} ${rollbackRes.restoredCount === 1 ? 'change' : 'changes'}`,
							);
						} catch (undoErr) {
							undoBtn.disabled = false;
							undoBtn.setText('Undo');
							const errEl = card.createDiv({
								cls: 'anti-dian-changeset-errors',
							});
							errEl.createDiv({
								text: `Notice: ${undoErr instanceof Error ? undoErr.message : String(undoErr)}`,
								cls: 'anti-dian-changeset-error-item',
							});
						}
					};

					resultNotice.className =
						'anti-dian-changeset-result-notice anti-dian-notice-applied';
				} catch (err) {
					applyBtn.disabled = false;
					rejectBtn.disabled = false;
					applyBtn.setText('Apply');
					const errEl = card.createDiv({
						cls: 'anti-dian-changeset-errors',
					});
					errEl.createDiv({
						text: `Notice: ${err instanceof Error ? err.message : String(err)}`,
						cls: 'anti-dian-changeset-error-item',
					});
				}
			};
		}
	}

	private renderFileDiffContent(
		container: HTMLElement,
		file: {
			path: string;
			heading?: string;
			additions: number;
			deletions: number;
			hunks: {
				header?: string;
				lines: {
					type: 'context' | 'added' | 'removed';
					content: string;
					oldLineNumber?: number;
					newLineNumber?: number;
				}[];
			}[];
		},
	): void {
		const diffBox = container.createDiv({ cls: 'anti-dian-diff-preview' });

		for (const hunk of file.hunks) {
			if (hunk.header) {
				diffBox.createDiv({
					text: hunk.header,
					cls: 'anti-dian-diff-line diff-hunk-header',
				});
			}
			for (const line of hunk.lines) {
				const lineEl = diffBox.createDiv({
					cls: `anti-dian-diff-line diff-${line.type}`,
				});
				const prefix =
					line.type === 'added'
						? '+'
						: line.type === 'removed'
							? '-'
							: ' ';
				lineEl.setText(`${prefix} ${line.content}`);
			}
		}
	}

	private renderDiffPreview(
		container: HTMLElement,
		diff: {
			totalAdditions: number;
			totalDeletions: number;
			files: {
				path: string;
				operationType: 'create' | 'patch-section';
				heading?: string;
				additions: number;
				deletions: number;
				hunks: {
					header?: string;
					lines: {
						type: 'context' | 'added' | 'removed';
						content: string;
						oldLineNumber?: number;
						newLineNumber?: number;
					}[];
				}[];
			}[];
		},
	): void {
		const summary = container.createDiv({ cls: 'anti-dian-diff-summary' });
		summary.createSpan({
			text: `${diff.files.length} ${diff.files.length === 1 ? 'file' : 'files'} changed`,
			cls: 'anti-dian-diff-summary-text',
		});
		if (diff.totalAdditions > 0) {
			summary.createSpan({
				text: `+${diff.totalAdditions}`,
				cls: 'anti-dian-diff-count-add',
			});
		}
		if (diff.totalDeletions > 0) {
			summary.createSpan({
				text: `-${diff.totalDeletions}`,
				cls: 'anti-dian-diff-count-del',
			});
		}

		for (const file of diff.files) {
			const fileCard = container.createDiv({
				cls: 'anti-dian-diff-file-card',
			});

			const fileHeader = fileCard.createDiv({
				cls: 'anti-dian-diff-file-header',
			});
			fileHeader.createSpan({
				text: file.path,
				cls: 'anti-dian-diff-file-path',
			});

			if (file.heading) {
				fileHeader.createSpan({
					text: ` > #${file.heading}`,
					cls: 'anti-dian-diff-file-heading',
				});
			}

			const countsSpan = fileHeader.createSpan({
				cls: 'anti-dian-op-diff-counts',
			});
			if (file.additions > 0) {
				countsSpan.createSpan({
					text: `+${file.additions}`,
					cls: 'anti-dian-diff-count-add',
				});
			}
			if (file.deletions > 0) {
				countsSpan.createSpan({
					text: `-${file.deletions}`,
					cls: 'anti-dian-diff-count-del',
				});
			}

			this.renderFileDiffContent(fileCard, file);
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
