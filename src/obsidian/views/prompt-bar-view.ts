import {
	App,
	Menu,
	SearchResult,
	prepareFuzzySearch,
	renderResults,
	setIcon,
	setTooltip,
} from 'obsidian';
import type AntiDianPlugin from '../../main';
import { ActiveContext } from '../../core/types/context';
import { MediaInput } from '../../core/types/model';
import type { PermissionMode } from '../../settings';
import { MenuGlider, attachNativeMenuGlider } from './menu-glider';
import { MediaPreviewModal } from './media-preview-modal';
import {
	PromptChip,
	PromptChipKind,
	chipAtCaret,
	rebaseChips,
	segmentPrompt,
} from './prompt-chips';

export interface PromptBarCallbacks {
	onSend: (text: string, media: MediaInput[]) => void | Promise<void>;
	onCancel?: () => void;
	onOpenModelMenu: (anchorEl: HTMLElement) => void;
	onPermissionChange: (mode: PermissionMode) => void;
	getCurrentModelLabel: () => string;
	getActiveContext: () => ActiveContext;
	onStartNewSession?: () => void;
}

interface AutocompleteItem {
	key: string;
	name: string;
	desc: string;
	icon?: string;
	type: 'source' | 'file' | 'command';
	action?: () => void;
	/** Fuzzy match against `name`, used to highlight matched characters. */
	match?: SearchResult;
}

const MAX_AT_ITEMS = 8;

const PERMISSION_MODES: { value: PermissionMode; label: string; desc: string; icon: string }[] = [
	{ value: 'ask', label: 'Ask', desc: 'Approve changes before they are applied', icon: 'lock' },
	{ value: 'plan', label: 'Plan', desc: 'Read-only proposals', icon: 'shield' },
	{ value: 'auto', label: 'Auto', desc: 'Apply valid changes automatically', icon: 'unlock' },
];

const MODEL_EFFORT_PATTERN = /^(.+?)\s+(Low|Medium|High|Minimal|Max|Thinking)$/;

interface ContextMenuItem {
	key: string;
	label: string;
	icon: string;
	badge?: string;
	disabled?: boolean;
	action: () => void;
}

/* Violet palette sampled from assets/logo.png */
const OBSIDIAN_CRYSTAL_STOPS = [
	'rgba(69, 27, 158, 0.85)',   // Inner fold shadow
	'rgba(98, 46, 211, 0.9)',    // Deep left leg
	'rgba(139, 76, 245, 0.95)',  // Right face
	'rgba(216, 193, 250, 1.0)',  // Light center highlight
	'rgba(185, 145, 252, 0.98)', // Lavender crown
	'rgba(139, 76, 245, 0.95)',  // Right face
	'rgba(69, 27, 158, 0.85)',   // Inner fold shadow
];

const DEFAULT_SLASH_COMMANDS: AutocompleteItem[] = [
	{ key: 'compare', name: '/compare', desc: 'Compare notes, ideas, or topics', icon: 'git-compare', type: 'command' },
	{ key: 'plan', name: '/plan', desc: 'Draft an actionable step-by-step plan', icon: 'list-checks', type: 'command' },
	{ key: 'search', name: '/search', desc: 'Deep search across vault notes', icon: 'search', type: 'command' },
	{ key: 'summarize', name: '/summarize', desc: 'Summarize note or conversation context', icon: 'file-text', type: 'command' },
	{ key: 'clear', name: '/clear', desc: 'Start a fresh conversation session', icon: 'trash-2', type: 'command' },
];

export class PromptBarView {
	private app: App;
	private plugin: AntiDianPlugin;
	private callbacks: PromptBarCallbacks;

	private rootEl: HTMLElement;
	private composerAnchorEl!: HTMLElement;
	private cardEl!: HTMLElement;
	private canvasEl!: HTMLCanvasElement;
	private mediaTrayEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	/** Paints chip backgrounds behind the textarea text (same metrics as the textarea). */
	private highlightEl!: HTMLElement;
	/** Ranges inserted via autocomplete; only these render as chips. */
	private chips: PromptChip[] = [];
	/** Textarea value the chips are anchored to. */
	private chipsText = '';
	private measureEl!: HTMLElement;
	private controlsRowEl!: HTMLElement;
	private fileInputEl!: HTMLInputElement;

	private plusBtnEl!: HTMLButtonElement;
	private modelPillEl!: HTMLElement;
	private modelPillLabelEl!: HTMLElement;
	private activeNotePillEl!: HTMLElement;
	private activeNoteLabelEl!: HTMLElement;
	private permissionPillEl!: HTMLElement;
	private permissionIconEl!: HTMLElement;
	private permissionLabelEl!: HTMLElement;
	private permissionMenu: Menu | null = null;
	private permissionMenuHiddenAt = 0;
	private onDocPointerDown = (e: PointerEvent): void => {
		const target = e.target as HTMLElement;
		if (
			this.contextMenuEl &&
			!target.closest('.anti-dian-context-menu') &&
			!target.closest('.anti-dian-promptbar-btn-plus')
		) {
			this.closePlusMenu();
		}
		if (
			this.menuContainerEl &&
			!target.closest('.anti-dian-promptbar-autocomplete') &&
			!target.closest('.anti-dian-promptbar-btn-plus')
		) {
			this.closeAutocompleteMenu();
		}
	};
	private sendBtnEl!: HTMLButtonElement;

	private contextMenuEl: HTMLElement | null = null;
	private menuContainerEl: HTMLElement | null = null;
	private gliderEl: HTMLElement | null = null;
	private menuRowEls: HTMLElement[] = [];

	private stagedMedia: MediaInput[] = [];
	private isMenuDismissed = false;
	private activeRowIndex = 0;
	private isGliderEngaged = false;
	private includeActiveNote = true;
	private isSending = false;

	private animFrameId: number | null = null;
	private isSweeping = false;

	constructor(
		containerEl: HTMLElement,
		app: App,
		plugin: AntiDianPlugin,
		callbacks: PromptBarCallbacks,
	) {
		this.app = app;
		this.plugin = plugin;
		this.callbacks = callbacks;
		this.rootEl = containerEl;

		this.render();
		this.setupEventListeners();
	}

	public destroy(): void {
		if (this.animFrameId !== null) {
			window.cancelAnimationFrame(this.animFrameId);
			this.animFrameId = null;
		}
		this.rootEl.doc.removeEventListener('pointerdown', this.onDocPointerDown);
		this.closePlusMenu();
		this.closeAutocompleteMenu();
		this.closePermissionMenu();
	}

	public getStagedMedia(): MediaInput[] {
		return [...this.stagedMedia];
	}

	public clearStagedMedia(): void {
		this.stagedMedia = [];
		this.renderMediaTray();
	}

	public getText(): string {
		return this.inputEl?.value ?? '';
	}

	public setText(value: string): void {
		if (this.inputEl) {
			this.inputEl.value = value;
			this.chips = [];
			this.syncChips();
			this.adjustTextareaHeight();
			this.updateSendButtonState();
		}
	}

	public focus(): void {
		this.inputEl?.focus();
	}

	public setRunning(running: boolean): void {
		this.isSending = running;
		if (!this.sendBtnEl) return;
		this.sendBtnEl.empty();
		if (running) {
			this.sendBtnEl.addClass('is-stop');
			this.sendBtnEl.removeClass('is-active');
			this.sendBtnEl.disabled = false;
			setIcon(this.sendBtnEl, 'square');
			setTooltip(this.sendBtnEl, 'Stop generating (Esc)');
			this.sendBtnEl.setAttribute('aria-label', 'Stop generating');
		} else {
			this.sendBtnEl.removeClass('is-stop');
			setIcon(this.sendBtnEl, 'arrow-right');
			setTooltip(this.sendBtnEl, 'Send message');
			this.sendBtnEl.setAttribute('aria-label', 'Send message');
			this.updateSendButtonState();
		}
	}

	public updateModelLabel(label?: string): void {
		if (!this.modelPillLabelEl) return;
		const fullLabel = label ?? this.callbacks.getCurrentModelLabel();
		this.modelPillLabelEl.empty();
		const match = MODEL_EFFORT_PATTERN.exec(fullLabel);
		if (match && match[1] && match[2]) {
			this.modelPillLabelEl.createSpan({
				cls: 'anti-dian-promptbar-model-base',
				text: match[1],
			});
			this.modelPillLabelEl.createSpan({
				cls: 'anti-dian-promptbar-model-effort',
				text: match[2],
			});
		} else {
			this.modelPillLabelEl.createSpan({
				cls: 'anti-dian-promptbar-model-base',
				text: fullLabel,
			});
		}
	}

	public updateActiveNotePill(context?: ActiveContext): void {
		if (!this.activeNotePillEl || !this.activeNoteLabelEl) return;
		const ctx = context ?? this.callbacks.getActiveContext();
		const hasNote = Boolean(ctx.activeFile);
		const noteName = hasNote
			? ctx.activeFile?.replace(/\.md$/, '').split('/').pop() || 'Untitled'
			: 'No note';

		this.activeNoteLabelEl.setText(noteName);

		if (!hasNote) {
			this.activeNotePillEl.addClass('is-empty');
			this.activeNotePillEl.removeClass('is-active');
			this.activeNotePillEl.removeClass('is-inactive');
			this.activeNotePillEl.setAttribute('aria-label', 'No active note opened');
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

	public isContextIncluded(): boolean {
		return this.includeActiveNote;
	}

	private getObsidianThemeStops(): string[] {
		const rootStyles = window.getComputedStyle(document.body);
		const accentRgb = rootStyles.getPropertyValue('--interactive-accent-rgb').trim();
		if (accentRgb) {
			const parts = accentRgb.split(',').map((v) => parseInt(v.trim(), 10));
			const r = parts[0];
			const g = parts[1];
			const b = parts[2];
			if (r !== undefined && g !== undefined && b !== undefined && !isNaN(r) && !isNaN(g) && !isNaN(b)) {
				const darkR = Math.max(0, Math.floor(r * 0.45));
				const darkG = Math.max(0, Math.floor(g * 0.4));
				const darkB = Math.min(255, Math.floor(b * 1.15 + 30));

				const brightR = Math.min(255, Math.floor(r * 1.25 + 35));
				const brightG = Math.min(255, Math.floor(g * 1.25 + 35));
				const brightB = Math.min(255, Math.floor(b * 1.05 + 20));

				const glowR = Math.min(255, Math.floor(r * 1.45 + 60));
				const glowG = Math.min(255, Math.floor(g * 1.45 + 60));
				const glowB = Math.min(255, Math.floor(b * 1.05 + 30));

				return [
					`rgba(${darkR}, ${darkG}, ${darkB}, 0.85)`,
					`rgba(${r}, ${g}, ${b}, 0.9)`,
					`rgba(${brightR}, ${brightG}, ${brightB}, 0.95)`,
					`rgba(${glowR}, ${glowG}, ${glowB}, 1.0)`,
					`rgba(${brightR}, ${brightG}, ${brightB}, 0.95)`,
					`rgba(${r}, ${g}, ${b}, 0.9)`,
					`rgba(${darkR}, ${darkG}, ${darkB}, 0.85)`,
				];
			}
		}
		return OBSIDIAN_CRYSTAL_STOPS;
	}

	/**
	 * Plays the smooth rainbow sweep animation across the card interior.
	 */
	public playRainbowSweep(): void {
		if (this.isSweeping) return;
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

		const canvas = this.canvasEl;
		if (!canvas) return;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		const rect = canvas.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		canvas.width = rect.width * dpr;
		canvas.height = rect.height * dpr;
		ctx.scale(dpr, dpr);

		this.isSweeping = true;
		const startTime = performance.now();
		const duration = 580; // ms
		const stops = this.getObsidianThemeStops();

		const renderFrame = (now: number) => {
			const elapsed = now - startTime;
			const progress = Math.min(1, elapsed / duration);

			ctx.clearRect(0, 0, rect.width, rect.height);

			if (progress < 1) {
				// Sweep position from -0.3 to 1.3
				const sweepPos = -0.3 + progress * 1.6;
				const gradientWidth = rect.width * 0.95;
				const x0 = sweepPos * rect.width - gradientWidth / 2;
				const x1 = x0 + gradientWidth;

				// Ease out expo opacity envelope
				const alphaEnvelope =
					progress < 0.15
						? progress / 0.15
						: Math.pow(1 - (progress - 0.15) / 0.85, 2);

				const gradient = ctx.createLinearGradient(x0, 0, x1, 0);
				for (let i = 0; i < stops.length; i++) {
					const stopPos = i / (stops.length - 1);
					gradient.addColorStop(stopPos, stops[i] ?? 'transparent');
				}

				ctx.save();
				ctx.globalAlpha = Math.min(0.32, alphaEnvelope * 0.42);
				ctx.fillStyle = gradient;
				ctx.fillRect(0, 0, rect.width, rect.height);
				ctx.restore();

				this.animFrameId = window.requestAnimationFrame(renderFrame);
			} else {
				ctx.clearRect(0, 0, rect.width, rect.height);
				this.isSweeping = false;
				this.animFrameId = null;
			}
		};

		this.animFrameId = window.requestAnimationFrame(renderFrame);
	}

	private render(): void {
		this.composerAnchorEl = this.rootEl.createDiv({
			cls: 'anti-dian-promptbar-anchor',
		});

		// Hidden file input for media uploads
		this.fileInputEl = this.composerAnchorEl.createEl('input', {
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

		// Outer shell (Antigravity-style context strip + composer card)
		const shellEl = this.composerAnchorEl.createDiv({
			cls: 'anti-dian-promptbar-shell',
		});

		// Top context bar (active note toggle)
		const contextBarEl = shellEl.createDiv({
			cls: 'anti-dian-promptbar-context-bar',
		});
		this.activeNotePillEl = contextBarEl.createDiv({
			cls: 'anti-dian-promptbar-note-pill',
			attr: {
				role: 'button',
				tabindex: '0',
				'aria-label': 'Toggle active note context',
			},
		});
		const noteIcon = this.activeNotePillEl.createSpan({
			cls: 'anti-dian-promptbar-note-icon',
		});
		setIcon(noteIcon, 'file-text');
		this.activeNoteLabelEl = this.activeNotePillEl.createSpan({
			cls: 'anti-dian-promptbar-note-label',
			text: 'No note',
		});
		this.activeNotePillEl.onclick = (e) => {
			e.stopPropagation();
			this.toggleActiveNote();
		};
		this.activeNotePillEl.onkeydown = (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this.toggleActiveNote();
			}
		};

		this.updateActiveNotePill();

		// The PromptBar Composer Card
		this.cardEl = shellEl.createDiv({
			cls: 'anti-dian-promptbar-card',
		});

		// Canvas for rainbow sweep animation
		this.canvasEl = this.cardEl.createEl('canvas', {
			cls: 'anti-dian-promptbar-canvas',
			attr: { 'aria-hidden': 'true' },
		});

		// Measure span for calculating text wrapping width
		this.measureEl = this.cardEl.createSpan({
			cls: 'anti-dian-promptbar-measure',
			attr: { 'aria-hidden': 'true' },
		});

		// Media tray (chips for attachments)
		this.mediaTrayEl = this.cardEl.createDiv({
			cls: 'anti-dian-promptbar-media-tray anti-dian-hidden',
		});

		// Main Textarea, over a mirror that draws chips for autocompleted items.
		const inputWrapEl = this.cardEl.createDiv({ cls: 'anti-dian-promptbar-input-wrap' });
		this.highlightEl = inputWrapEl.createDiv({
			cls: 'anti-dian-promptbar-highlight',
			attr: { 'aria-hidden': 'true' },
		});
		this.inputEl = inputWrapEl.createEl('textarea', {
			cls: 'anti-dian-promptbar-textarea',
			attr: {
				placeholder: 'Ask anything, @ to mention, / for actions',
				rows: '1',
				'aria-label': 'Prompt input',
			},
		});

		// Controls row
		this.controlsRowEl = this.cardEl.createDiv({
			cls: 'anti-dian-promptbar-controls',
		});

		// --- Left Controls ---
		const leftControls = this.controlsRowEl.createDiv({
			cls: 'anti-dian-promptbar-controls-left',
		});

		// Plus button (+)
		this.plusBtnEl = leftControls.createEl('button', {
			cls: 'anti-dian-promptbar-btn-plus',
			attr: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
		});
		setIcon(this.plusBtnEl, 'plus');
		setTooltip(this.plusBtnEl, 'Add context');
		this.plusBtnEl.onclick = (e) => {
			e.stopPropagation();
			this.togglePlusMenu();
		};

		// Model pill
		this.modelPillEl = leftControls.createDiv({
			cls: 'anti-dian-promptbar-model-pill',
			attr: {
				role: 'button',
				tabindex: '0',
				'aria-label': 'Choose model',
			},
		});
		this.modelPillLabelEl = this.modelPillEl.createSpan({
			cls: 'anti-dian-promptbar-model-name',
		});
		this.updateModelLabel();
		const modelChevron = this.modelPillEl.createSpan({
			cls: 'anti-dian-promptbar-chevron',
		});
		setIcon(modelChevron, 'chevron-down');
		this.modelPillEl.onclick = (e) => {
			e.stopPropagation();
			this.closePlusMenu();
			this.closeAutocompleteMenu();
			this.callbacks.onOpenModelMenu(this.modelPillEl);
		};

		// --- Right Controls ---
		const rightControls = this.controlsRowEl.createDiv({
			cls: 'anti-dian-promptbar-controls-right',
		});

		// Permission mode pill
		this.permissionPillEl = rightControls.createDiv({
			cls: 'anti-dian-promptbar-model-pill anti-dian-promptbar-permission-pill',
			attr: {
				role: 'button',
				tabindex: '0',
				'aria-label': 'Choose permission mode',
				'aria-haspopup': 'menu',
				'aria-expanded': 'false',
			},
		});
		this.permissionIconEl = this.permissionPillEl.createSpan({
			cls: 'anti-dian-promptbar-perm-icon',
		});
		this.permissionLabelEl = this.permissionPillEl.createSpan({
			cls: 'anti-dian-promptbar-model-name',
		});
		this.updatePermissionPill();
		const permissionChevron = this.permissionPillEl.createSpan({
			cls: 'anti-dian-promptbar-chevron',
		});
		setIcon(permissionChevron, 'chevron-down');
		this.permissionPillEl.onclick = (e) => {
			e.stopPropagation();
			this.closePlusMenu();
			this.closeAutocompleteMenu();
			this.togglePermissionMenu();
		};
		this.permissionPillEl.onkeydown = (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this.togglePermissionMenu();
			} else if (e.key === 'Escape') {
				this.closePermissionMenu();
			}
		};

		// Circular Send / Stop button
		this.sendBtnEl = rightControls.createEl('button', {
			cls: 'anti-dian-promptbar-btn-send',
			attr: { type: 'button', disabled: 'true', 'aria-label': 'Send message' },
		});
		setIcon(this.sendBtnEl, 'arrow-right');
		setTooltip(this.sendBtnEl, 'Send message');
		this.sendBtnEl.onclick = () => {
			if (this.isSending) {
				this.callbacks.onCancel?.();
			} else {
				void this.triggerSend();
			}
		};

		this.updateSendButtonState();
	}

	private setupEventListeners(): void {
		this.inputEl.addEventListener('scroll', () => {
			this.highlightEl.scrollTop = this.inputEl.scrollTop;
		});

		this.inputEl.addEventListener('input', () => {
			this.syncChips();
			this.isMenuDismissed = false;
			this.closePlusMenu();
			this.adjustTextareaHeight();
			this.updateSendButtonState();
			this.checkAndRenderAutocomplete();
		});

		this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
			if ((e.key === 'Backspace' || e.key === 'Delete') && this.deleteChipAtCaret(e.key)) {
				e.preventDefault();
				return;
			}
			if (this.contextMenuEl && e.key === 'Escape') {
				e.preventDefault();
				this.closePlusMenu();
				return;
			}
			if (this.menuContainerEl) {
				const rowsCount = this.menuRowEls.length;
				if (e.key === 'ArrowDown') {
					e.preventDefault();
					this.isGliderEngaged = true;
					this.activeRowIndex = (this.activeRowIndex + 1) % rowsCount;
					this.updateGliderPosition();
					return;
				}
				if (e.key === 'ArrowUp') {
					e.preventDefault();
					this.isGliderEngaged = true;
					this.activeRowIndex = (this.activeRowIndex - 1 + rowsCount) % rowsCount;
					this.updateGliderPosition();
					return;
				}
				if (e.key === 'Enter' && !e.shiftKey) {
					e.preventDefault();
					const activeRow = this.menuRowEls[this.activeRowIndex];
					if (activeRow) {
						activeRow.click();
					}
					return;
				}
				if (e.key === 'Tab') {
					e.preventDefault();
					const activeRow = this.menuRowEls[this.activeRowIndex];
					if (activeRow) {
						activeRow.click();
					}
					return;
				}
				if (e.key === 'Escape') {
					e.preventDefault();
					this.isMenuDismissed = true;
					this.closeAutocompleteMenu();
					return;
				}
			}

			if (e.key === 'Escape' && this.isSending) {
				e.preventDefault();
				this.callbacks.onCancel?.();
				return;
			}

			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				if (!this.isSending) {
					void this.triggerSend();
				}
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

		// Close autocomplete menu when clicking outside (removed in destroy()).
		this.rootEl.doc.addEventListener('pointerdown', this.onDocPointerDown);
	}

	private updatePermissionPill(): void {
		const mode = this.plugin.settings.permissionMode ?? 'ask';
		const option = PERMISSION_MODES.find((o) => o.value === mode) ?? PERMISSION_MODES[0];
		if (!option) return;
		if (this.permissionLabelEl) {
			this.permissionLabelEl.setText(option.label);
		}
		if (this.permissionIconEl) {
			this.permissionIconEl.empty();
			setIcon(this.permissionIconEl, option.icon);
		}
	}

	private togglePermissionMenu(): void {
		if (this.permissionMenu) {
			this.closePermissionMenu();
			return;
		}
		// The native menu hides on the pointerdown that precedes this click.
		if (Date.now() - this.permissionMenuHiddenAt < 300) return;

		const currentMode = this.plugin.settings.permissionMode ?? 'ask';
		const menu = new Menu();
		attachNativeMenuGlider(menu);
		menu.addItem((item) => item.setTitle('Permission').setIsLabel(true));
		for (const option of PERMISSION_MODES) {
			menu.addItem((item) => {
				const title = createFragment();
				title.appendText(option.label);
				title.createDiv({ cls: 'anti-dian-menu-item-desc', text: option.desc });
				item
					.setTitle(title)
					.setIcon(option.icon)
					.setChecked(option.value === currentMode)
					.onClick(() => {
						this.plugin.settings.permissionMode = option.value;
						this.updatePermissionPill();
						this.callbacks.onPermissionChange(option.value);
					});
			});
		}
		menu.onHide(() => {
			if (this.permissionMenu === menu) this.permissionMenu = null;
			this.permissionMenuHiddenAt = Date.now();
			this.permissionPillEl.setAttribute('aria-expanded', 'false');
		});

		this.permissionMenu = menu;
		this.permissionPillEl.setAttribute('aria-expanded', 'true');
		const rect = this.permissionPillEl.getBoundingClientRect();
		menu.showAtPosition(
			{ x: rect.right, y: rect.bottom + 4, width: rect.width, left: true },
			this.permissionPillEl.doc,
		);
	}

	private closePermissionMenu(): void {
		this.permissionMenu?.hide();
		this.permissionMenu = null;
		this.permissionPillEl?.setAttribute('aria-expanded', 'false');
	}

	private canSend(): boolean {
		const text = this.inputEl?.value.trim() ?? '';
		return text.length > 0 || this.stagedMedia.length > 0;
	}

	private updateSendButtonState(): void {
		if (!this.sendBtnEl || this.isSending) return;
		const ready = this.canSend();
		this.sendBtnEl.disabled = !ready;
		if (ready) {
			this.sendBtnEl.addClass('is-active');
		} else {
			this.sendBtnEl.removeClass('is-active');
		}
	}

	private adjustTextareaHeight(): void {
		const input = this.inputEl;
		if (!input) return;

		input.setCssProps({ height: 'auto' });
		const scrollH = input.scrollHeight;
		const minH = 28;
		const maxH = 120;
		const nextH = Math.min(Math.max(scrollH, minH), maxH);
		input.setCssProps({
			height: `${nextH}px`,
		});

		if (scrollH > maxH) {
			input.addClass('is-scrollable');
		} else {
			input.removeClass('is-scrollable');
		}
		// Same scrollbar gutter on the chip mirror, so its lines wrap identically.
		this.highlightEl?.toggleClass('is-scrollable', scrollH > maxH);

		// Check if controls should be stacked or inline
		if (nextH > 36 || input.value.includes('\n')) {
			this.cardEl.addClass('is-expanded');
		} else {
			this.cardEl.removeClass('is-expanded');
		}
	}

	private async triggerSend(): Promise<void> {
		if (!this.canSend() || this.isSending) return;

		const text = this.inputEl.value.trim();
		const media = [...this.stagedMedia];

		this.inputEl.value = '';
		this.chips = [];
		this.syncChips();
		this.stagedMedia = [];
		this.renderMediaTray();
		this.adjustTextareaHeight();
		this.closeAutocompleteMenu();
		this.updateSendButtonState();

		await this.callbacks.onSend(text, media);
	}

	private toggleActiveNote(): void {
		const ctx = this.callbacks.getActiveContext();
		if (!ctx.activeFile) return;
		this.includeActiveNote = !this.includeActiveNote;
		this.updateActiveNotePill(ctx);
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
		this.updateSendButtonState();
	}

	private createMediaRemoveButton(parent: HTMLElement, cls: string, onRemove: () => void): void {
		const removeBtn = parent.createEl('button', {
			cls,
			attr: { type: 'button', 'aria-label': 'Remove attachment' },
		});
		setIcon(removeBtn, 'x');
		setTooltip(removeBtn, 'Remove attachment');
		removeBtn.onclick = (e) => {
			e.stopPropagation();
			onRemove();
		};
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
			const idx = i;
			const remove = () => {
				this.stagedMedia.splice(idx, 1);
				this.renderMediaTray();
				this.updateSendButtonState();
			};

			// Images and videos get a preview tile; anything else a compact chip.
			const previewable = Boolean(item.data) && (item.type === 'image' || item.type === 'video');
			if (previewable && item.data) {
				const tile = this.mediaTrayEl.createDiv({
					cls: 'anti-dian-promptbar-media-tile',
					attr: {
						role: 'button',
						tabindex: '0',
						'aria-label': item.type === 'image' ? 'Preview image' : 'Preview video',
					},
				});
				const openPreview = () => new MediaPreviewModal(this.app, item).open();
				tile.addEventListener('click', openPreview);
				tile.addEventListener('keydown', (e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						openPreview();
					} else if (e.key === 'Delete' || e.key === 'Backspace') {
						e.preventDefault();
						remove();
						this.inputEl.focus();
					}
				});
				if (item.type === 'image') {
					tile.createEl('img', {
						cls: 'anti-dian-promptbar-media-preview',
						attr: { src: item.data, alt: 'Attached image', draggable: 'false' },
					});
				} else {
					const video = tile.createEl('video', {
						cls: 'anti-dian-promptbar-media-preview',
						attr: { src: item.data, preload: 'metadata', 'aria-label': 'Attached video' },
					});
					video.muted = true;
					video.playsInline = true;
					const badge = tile.createSpan({ cls: 'anti-dian-promptbar-media-badge' });
					setIcon(badge, 'play');
				}
				this.createMediaRemoveButton(tile, 'anti-dian-promptbar-media-tile-remove', remove);
				continue;
			}

			const chip = this.mediaTrayEl.createDiv({
				cls: 'anti-dian-promptbar-media-chip',
			});
			const iconSpan = chip.createSpan({
				cls: 'anti-dian-promptbar-chip-icon',
			});
			setIcon(iconSpan, item.type === 'video' ? 'video' : item.type === 'audio' ? 'audio-lines' : 'file');
			chip.createSpan({
				cls: 'anti-dian-promptbar-chip-name',
				text: item.type === 'image' ? 'Image' : item.type,
			});
			this.createMediaRemoveButton(chip, 'anti-dian-promptbar-chip-remove', remove);
		}
	}

	/* ------------------------------------------------------------- */
	/* Autocomplete & @ / / Menus                                    */
	/* ------------------------------------------------------------- */

	private parseToken(text: string): { kind: 'at' | 'slash'; query: string; start: number } | null {
		const match = /(^|\s)([@/])([\w-]*)$/.exec(text);
		if (!match || match[1] === undefined || !match[2]) return null;
		return {
			kind: match[2] === '@' ? 'at' : 'slash',
			query: match[3]?.toLowerCase() ?? '',
			start: match.index + match[1].length,
		};
	}

	private togglePlusMenu(): void {
		if (this.contextMenuEl) {
			this.closePlusMenu();
		} else {
			this.closeAutocompleteMenu();
			this.closePermissionMenu();
			this.renderPlusMenu();
		}
	}

	private closePlusMenu(): void {
		if (this.contextMenuEl) {
			this.contextMenuEl.remove();
			this.contextMenuEl = null;
		}
		this.plusBtnEl?.setAttribute('aria-expanded', 'false');
	}

	private insertTriggerAndOpen(trigger: '@' | '/'): void {
		this.closePlusMenu();
		const current = this.inputEl.value;
		const needsSpace = current.length > 0 && !/\s$/.test(current);
		this.inputEl.value = `${current}${needsSpace ? ' ' : ''}${trigger}`;
		this.syncChips();
		this.isMenuDismissed = false;
		this.adjustTextareaHeight();
		this.updateSendButtonState();
		this.inputEl.focus();
		this.inputEl.setSelectionRange(this.inputEl.value.length, this.inputEl.value.length);
		this.checkAndRenderAutocomplete();
	}

	private renderPlusMenu(): void {
		this.closePlusMenu();

		const ctx = this.callbacks.getActiveContext();
		const hasActiveNote = Boolean(ctx.activeFile);

		const items: ContextMenuItem[] = [
			{
				key: 'files',
				label: 'Files',
				icon: 'paperclip',
				action: () => {
					this.closePlusMenu();
					this.fileInputEl.click();
				},
			},
			{
				key: 'mentions',
				label: 'Mentions',
				icon: 'at-sign',
				action: () => this.insertTriggerAndOpen('@'),
			},
			{
				key: 'actions',
				label: 'Actions',
				icon: 'square-pen',
				action: () => this.insertTriggerAndOpen('/'),
			},
			{
				key: 'active-note',
				label: 'Active note',
				icon: 'file-text',
				badge: hasActiveNote ? (this.includeActiveNote ? 'On' : 'Off') : 'None',
				disabled: !hasActiveNote,
				action: () => {
					this.toggleActiveNote();
					this.closePlusMenu();
				},
			},
			{
				key: 'web',
				label: 'Web search',
				icon: 'globe',
				action: () => {
					this.closePlusMenu();
					const current = this.inputEl.value;
					const needsSpace = current.length > 0 && !/\s$/.test(current);
					this.insertChip(`${current}${needsSpace ? ' ' : ''}`, '@Web search', 'source');
					this.adjustTextareaHeight();
					this.updateSendButtonState();
					this.inputEl.focus();
				},
			},
		];

		const menuEl = this.composerAnchorEl.createDiv({
			cls: 'anti-dian-context-menu',
			attr: { role: 'menu', 'aria-label': 'Add context' },
		});
		this.contextMenuEl = menuEl;
		this.plusBtnEl.setAttribute('aria-expanded', 'true');

		menuEl.createDiv({
			cls: 'anti-dian-context-menu-header',
			text: 'Add context',
		});

		const listEl = menuEl.createDiv({
			cls: 'anti-dian-context-menu-list',
		});
		new MenuGlider(listEl).trackHover('.anti-dian-context-menu-row');

		for (const item of items) {
			const rowBtn = listEl.createEl('button', {
				cls: 'anti-dian-context-menu-row',
				attr: {
					type: 'button',
					role: 'menuitem',
					...(item.disabled ? { disabled: 'true' } : {}),
				},
			});

			const iconEl = rowBtn.createSpan({
				cls: 'anti-dian-context-menu-icon',
			});
			setIcon(iconEl, item.icon);

			rowBtn.createSpan({
				cls: 'anti-dian-context-menu-label',
				text: item.label,
			});

			if (item.badge) {
				rowBtn.createSpan({
					cls: `anti-dian-context-menu-badge${item.badge === 'On' ? ' is-on' : ''}`,
					text: item.badge,
				});
			}

			rowBtn.onclick = (e) => {
				e.stopPropagation();
				if (!item.disabled) {
					item.action();
				}
			};
		}
	}

	private checkAndRenderAutocomplete(): void {
		if (this.isMenuDismissed) {
			this.closeAutocompleteMenu();
			return;
		}

		const token = this.parseToken(this.inputEl.value);
		if (!token) {
			this.closeAutocompleteMenu();
			return;
		}

		this.renderAutocomplete(token.kind, token.query);
	}

	private getItems(kind: 'at' | 'slash', query: string): AutocompleteItem[] {
		const fuzzy = query ? prepareFuzzySearch(query) : null;

		if (kind === 'slash') {
			if (!fuzzy) return DEFAULT_SLASH_COMMANDS;
			return DEFAULT_SLASH_COMMANDS.flatMap((c) => {
				const match = fuzzy(c.name.slice(1));
				return match ? [{ ...c, match }] : [];
			}).sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0));
		}

		// '@' Sources and Vault Notes
		const items: AutocompleteItem[] = [
			{
				key: 'attach',
				name: 'Add photos & files',
				desc: 'Upload from your device',
				icon: 'paperclip',
				type: 'source',
				action: () => this.fileInputEl.click(),
			},
			{
				key: 'web',
				name: 'Web search',
				desc: 'Live real-time search',
				icon: 'globe',
				type: 'source',
			},
		];

		// Active note
		const ctx = this.callbacks.getActiveContext();
		if (ctx.activeFile) {
			const name = ctx.activeFile.replace(/\.md$/, '').split('/').pop() || 'Active Note';
			items.push({
				key: 'active-note',
				name: name,
				desc: 'Active note in editor',
				icon: 'file-text',
				type: 'file',
			});
		}

		// Vault Markdown files, ranked by fuzzy match on the basename.
		const matches: AutocompleteItem[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			// Avoid duplicating active note
			if (ctx.activeFile && file.path === ctx.activeFile) continue;
			const match = fuzzy ? fuzzy(file.basename) : null;
			if (fuzzy && !match) continue;
			matches.push({
				key: file.path,
				name: file.basename,
				desc: file.parent ? file.parent.path : 'Vault root',
				icon: 'file',
				type: 'file',
				match: match ?? undefined,
			});
			if (!fuzzy && items.length + matches.length >= MAX_AT_ITEMS) break;
		}
		matches.sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0));
		items.push(...matches.slice(0, Math.max(0, MAX_AT_ITEMS - items.length)));

		return items;
	}

	private renderAutocomplete(kind: 'at' | 'slash', query: string): void {
		const items = this.getItems(kind, query);

		if (!this.menuContainerEl) {
			this.menuContainerEl = this.composerAnchorEl.createDiv({
				cls: 'anti-dian-promptbar-autocomplete',
			});
		} else {
			this.menuContainerEl.empty();
		}

		this.menuRowEls = [];
		this.activeRowIndex = 0;
		this.isGliderEngaged = false;

		const listEl = this.menuContainerEl.createDiv({
			cls: 'anti-dian-promptbar-menu-list',
		});

		// Gliding highlight element (inside listEl so offsetTop aligns 1:1 with rows)
		this.gliderEl = listEl.createSpan({
			cls: 'anti-dian-promptbar-glider',
			attr: { 'aria-hidden': 'true' },
		});

		if (items.length === 0) {
			listEl.createDiv({
				cls: 'anti-dian-promptbar-menu-empty',
				text: `No matches for "${query}"`,
			});
		} else {
			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if (!item) continue;

				const rowBtn = listEl.createEl('button', {
					cls: 'anti-dian-promptbar-menu-row',
					attr: { type: 'button' },
				});

				const iconWrapper = rowBtn.createSpan({
					cls: 'anti-dian-promptbar-menu-icon',
				});
				if (item.icon) {
					setIcon(iconWrapper, item.icon);
				}

				const nameEl = rowBtn.createSpan({
					cls: 'anti-dian-promptbar-menu-name',
				});
				if (item.type === 'command') {
					// Slash command matches are computed without the leading "/".
					nameEl.appendText('/');
					this.renderName(nameEl, item.name.slice(1), item.match);
				} else {
					nameEl.appendText('@');
					this.renderName(nameEl, item.name, item.match);
				}

				rowBtn.createSpan({
					cls: 'anti-dian-promptbar-menu-desc',
					text: item.desc,
				});

				rowBtn.onmouseenter = () => {
					this.activeRowIndex = i;
					this.isGliderEngaged = true;
					this.updateGliderPosition();
				};

				rowBtn.onclick = (e) => {
					e.stopPropagation();
					this.pickAutocompleteItem(item, kind);
				};

				this.menuRowEls.push(rowBtn);
			}
		}

		// Menu footer guide
		const footer = this.menuContainerEl.createDiv({
			cls: 'anti-dian-promptbar-menu-footer',
		});
		footer.setText(
			kind === 'at'
				? 'Type to search notes & sources'
				: 'Type to search commands',
		);

		this.updateGliderPosition();
	}

	private renderName(el: HTMLElement, text: string, match?: SearchResult): void {
		if (match) {
			renderResults(el, text, match);
		} else {
			el.appendText(text);
		}
	}

	private updateGliderPosition(): void {
		if (!this.gliderEl || this.menuRowEls.length === 0) return;
		const target = this.menuRowEls[this.activeRowIndex];
		if (!target) return;

		this.gliderEl.setCssProps({
			top: `${target.offsetTop}px`,
			height: `${target.offsetHeight}px`,
			opacity: this.isGliderEngaged ? '1' : '0.5',
		});
	}

	private pickAutocompleteItem(item: AutocompleteItem, kind: 'at' | 'slash'): void {
		if (item.action) {
			item.action();
			this.closeAutocompleteMenu();
			this.inputEl.focus();
			return;
		}

		const token = this.parseToken(this.inputEl.value);
		const currentVal = this.inputEl.value;

		if (item.key === 'clear') {
			this.inputEl.value = '';
			this.chips = [];
			this.syncChips();
			this.callbacks.onStartNewSession?.();
			this.closeAutocompleteMenu();
			this.inputEl.focus();
			return;
		}

		const prefix = token ? currentVal.slice(0, token.start) : currentVal;
		if (kind === 'at') {
			this.insertChip(prefix, `@${item.name}`, item.type === 'source' ? 'source' : 'file');
		} else {
			this.insertChip(prefix, item.name, 'command');
		}

		this.closeAutocompleteMenu();
		this.adjustTextareaHeight();
		this.updateSendButtonState();
		this.inputEl.focus();
	}

	/* ------------------------------------------------------------- */
	/* Chips                                                         */
	/* ------------------------------------------------------------- */

	/** Sets the value to `prefix + label + ' '` and marks `label` as a chip. */
	private insertChip(prefix: string, label: string, kind: PromptChipKind): void {
		this.inputEl.value = `${prefix}${label} `;
		this.syncChips();
		this.chips.push({ start: prefix.length, end: prefix.length + label.length, kind });
		this.renderHighlight();
		const caret = this.inputEl.value.length;
		this.inputEl.setSelectionRange(caret, caret);
	}

	/** Re-anchors chips to the current value and repaints them. */
	private syncChips(): void {
		const value = this.inputEl.value;
		this.chips = rebaseChips(this.chips, this.chipsText, value);
		this.chipsText = value;
		this.renderHighlight();
	}

	/** Backspace after / Delete before a chip removes the whole chip. */
	private deleteChipAtCaret(key: 'Backspace' | 'Delete'): boolean {
		const input = this.inputEl;
		if (input.selectionStart !== input.selectionEnd) return false;
		const chip = chipAtCaret(this.chips, input.selectionStart, key);
		if (!chip) return false;
		input.setRangeText('', chip.start, chip.end, 'start');
		input.dispatchEvent(new Event('input', { bubbles: true }));
		return true;
	}

	private renderHighlight(): void {
		const el = this.highlightEl;
		if (!el) return;
		el.empty();
		if (this.chips.length === 0) return;
		for (const segment of segmentPrompt(this.inputEl.value, this.chips)) {
			if (segment.chip) {
				el.createSpan({
					cls: `anti-dian-prompt-chip is-${segment.chip.kind}`,
					text: segment.text,
				});
			} else {
				el.appendText(segment.text);
			}
		}
		// A trailing newline needs a character after it to take up a line.
		if (this.inputEl.value.endsWith('\n')) el.appendText(' ');
		el.scrollTop = this.inputEl.scrollTop;
	}

	public closeAutocompleteMenu(): void {
		if (this.menuContainerEl) {
			this.menuContainerEl.remove();
			this.menuContainerEl = null;
		}
		this.menuRowEls = [];
	}
}
