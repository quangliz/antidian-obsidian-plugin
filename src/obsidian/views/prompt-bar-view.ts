import { App, setIcon } from 'obsidian';
import type AntiDianPlugin from '../../main';
import { ActiveContext } from '../../core/types/context';
import { MediaInput } from '../../core/types/model';
import type { PermissionMode } from '../../settings';

export interface PromptBarCallbacks {
	onSend: (text: string, media: MediaInput[]) => void | Promise<void>;
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
}

const PERMISSION_MODES: { value: PermissionMode; label: string; desc: string }[] = [
	{ value: 'ask', label: 'Ask', desc: 'Approve changes before they are applied' },
	{ value: 'plan', label: 'Plan', desc: 'Read-only proposals' },
	{ value: 'auto', label: 'Auto', desc: 'Apply valid changes automatically' },
];

/* Obsidian crystal gemstone color palette matching assets/logo.png */
const OBSIDIAN_CRYSTAL_STOPS = [
	'rgba(45, 27, 206, 0.85)',   // Deep Electric Indigo
	'rgba(90, 40, 235, 0.9)',    // Royal Violet
	'rgba(139, 69, 254, 0.95)',  // Obsidian Purple Accent
	'rgba(225, 160, 255, 1.0)',  // Glowing Amethyst Highlight
	'rgba(185, 115, 255, 0.98)', // Crystal Lilac
	'rgba(139, 69, 254, 0.95)',  // Obsidian Purple Accent
	'rgba(45, 27, 206, 0.85)',   // Deep Electric Indigo
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
	private measureEl!: HTMLElement;
	private controlsRowEl!: HTMLElement;
	private fileInputEl!: HTMLInputElement;

	private plusBtnEl!: HTMLButtonElement;
	private modelPillEl!: HTMLElement;
	private modelPillLabelEl!: HTMLElement;
	private activeNotePillEl!: HTMLElement;
	private activeNoteLabelEl!: HTMLElement;
	private permissionPillEl!: HTMLElement;
	private permissionLabelEl!: HTMLElement;
	private permissionMenuEl: HTMLElement | null = null;
	private sendBtnEl!: HTMLButtonElement;

	private menuContainerEl: HTMLElement | null = null;
	private gliderEl: HTMLElement | null = null;
	private menuRowEls: HTMLElement[] = [];

	private stagedMedia: MediaInput[] = [];
	private isPlusMenuOpen = false;
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
			this.adjustTextareaHeight();
			this.updateSendButtonState();
		}
	}

	public focus(): void {
		this.inputEl?.focus();
	}

	public setDisabled(disabled: boolean): void {
		this.isSending = disabled;
		if (this.sendBtnEl) {
			this.sendBtnEl.disabled = disabled || !this.canSend();
		}
		if (this.inputEl) {
			this.inputEl.disabled = disabled;
		}
	}

	public updateModelLabel(label?: string): void {
		if (this.modelPillLabelEl) {
			this.modelPillLabelEl.setText(label ?? this.callbacks.getCurrentModelLabel());
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

		// The PromptBar Composer Card
		this.cardEl = this.composerAnchorEl.createDiv({
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

		// Main Textarea
		this.inputEl = this.cardEl.createEl('textarea', {
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
			attr: {
				type: 'button',
				'aria-label': 'Add attachments and sources',
			},
		});
		setIcon(this.plusBtnEl, 'plus');
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
			text: this.callbacks.getCurrentModelLabel(),
		});
		const modelChevron = this.modelPillEl.createSpan({
			cls: 'anti-dian-promptbar-chevron',
		});
		setIcon(modelChevron, 'chevron-down');
		this.modelPillEl.onclick = (e) => {
			e.stopPropagation();
			this.closeAutocompleteMenu();
			this.callbacks.onOpenModelMenu(this.modelPillEl);
		};

		// Active note pill
		this.activeNotePillEl = leftControls.createDiv({
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

		this.updateActiveNotePill();

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
		this.permissionLabelEl = this.permissionPillEl.createSpan({
			cls: 'anti-dian-promptbar-model-name',
			text: this.getPermissionLabel(),
		});
		const permissionChevron = this.permissionPillEl.createSpan({
			cls: 'anti-dian-promptbar-chevron',
		});
		setIcon(permissionChevron, 'chevron-down');
		this.permissionPillEl.onclick = (e) => {
			e.stopPropagation();
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

		// Tactile Send button
		this.sendBtnEl = rightControls.createEl('button', {
			cls: 'anti-dian-promptbar-btn-send',
			attr: {
				type: 'button',
				'aria-label': 'Send message',
				disabled: 'true',
			},
		});
		setIcon(this.sendBtnEl, 'arrow-up');
		this.sendBtnEl.onclick = () => {
			void this.triggerSend();
		};

		this.updateSendButtonState();
	}

	private setupEventListeners(): void {
		this.inputEl.addEventListener('input', () => {
			this.isMenuDismissed = false;
			this.isPlusMenuOpen = false;
			this.adjustTextareaHeight();
			this.updateSendButtonState();
			this.checkAndRenderAutocomplete();
		});

		this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
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

			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				void this.triggerSend();
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

		// Close autocomplete menu when clicking outside
		document.addEventListener('pointerdown', (e: PointerEvent) => {
			const target = e.target as HTMLElement;
			if (
				this.permissionMenuEl &&
				!target.closest('.anti-dian-promptbar-permission-pill') &&
				!target.closest('.anti-dian-permission-menu')
			) {
				this.closePermissionMenu();
			}
			if (
				this.menuContainerEl &&
				!target.closest('.anti-dian-promptbar-autocomplete') &&
				!target.closest('.anti-dian-promptbar-btn-plus')
			) {
				this.closeAutocompleteMenu();
			}
		});
	}

	private getPermissionLabel(): string {
		const mode = this.plugin.settings.permissionMode ?? 'ask';
		return PERMISSION_MODES.find((option) => option.value === mode)?.label ?? 'Ask';
	}

	private togglePermissionMenu(): void {
		if (this.permissionMenuEl) {
			this.closePermissionMenu();
			return;
		}

		const currentMode = this.plugin.settings.permissionMode ?? 'ask';
		this.permissionMenuEl = document.body.createDiv({
			cls: 'anti-dian-model-menu anti-dian-permission-menu',
			attr: { role: 'menu', 'aria-label': 'Permission mode' },
		});
		this.permissionMenuEl.createDiv({
			cls: 'anti-dian-menu-header',
			text: 'Permission',
		});
		const list = this.permissionMenuEl.createDiv({ cls: 'anti-dian-menu-list' });

		for (const option of PERMISSION_MODES) {
			const selected = option.value === currentMode;
			const item = list.createDiv({
				cls: `anti-dian-menu-item ${selected ? 'is-selected' : ''}`,
				attr: {
					role: 'menuitemradio',
					'aria-checked': String(selected),
				},
			});
			const itemLeft = item.createDiv({ cls: 'anti-dian-menu-item-left' });
			itemLeft.createSpan({ cls: 'anti-dian-menu-item-title', text: option.label });
			itemLeft.createSpan({ cls: 'anti-dian-menu-item-effort', text: option.desc });

			if (selected) {
				const check = item.createSpan({ cls: 'anti-dian-menu-check' });
				setIcon(check, 'check');
			}

			item.onclick = (e) => {
				e.stopPropagation();
				this.plugin.settings.permissionMode = option.value;
				this.permissionLabelEl.setText(option.label);
				this.callbacks.onPermissionChange(option.value);
				this.closePermissionMenu();
			};
		}

		this.permissionPillEl.setAttribute('aria-expanded', 'true');
		const anchorRect = this.permissionPillEl.getBoundingClientRect();
		const menuWidth = this.permissionMenuEl.offsetWidth || 250;
		const menuHeight = this.permissionMenuEl.offsetHeight || 150;
		const top = window.innerHeight - anchorRect.bottom - 10 >= menuHeight
			? anchorRect.bottom + 6
			: Math.max(10, anchorRect.top - menuHeight - 6);
		const left = Math.max(10, Math.min(anchorRect.right - menuWidth, window.innerWidth - menuWidth - 10));
		this.permissionMenuEl.setCssProps({ left: `${left}px`, top: `${top}px` });
	}

	private closePermissionMenu(): void {
		this.permissionMenuEl?.remove();
		this.permissionMenuEl = null;
		this.permissionPillEl?.setAttribute('aria-expanded', 'false');
	}

	private canSend(): boolean {
		const text = this.inputEl?.value.trim() ?? '';
		return text.length > 0 || this.stagedMedia.length > 0;
	}

	private updateSendButtonState(): void {
		if (!this.sendBtnEl) return;
		const ready = this.canSend() && !this.isSending;
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
				cls: 'anti-dian-promptbar-media-chip',
			});

			if (item.type === 'image' && item.data) {
				chip.createEl('img', {
					cls: 'anti-dian-promptbar-chip-thumb',
					attr: { src: item.data },
				});
			} else {
				const iconSpan = chip.createSpan({
					cls: 'anti-dian-promptbar-chip-icon',
				});
				setIcon(iconSpan, item.type === 'video' ? 'video' : 'file');
			}

			chip.createSpan({
				cls: 'anti-dian-promptbar-chip-name',
				text: item.type === 'image' ? 'Image' : item.type,
			});

			const removeBtn = chip.createEl('button', {
				cls: 'anti-dian-promptbar-chip-remove',
				attr: { 'aria-label': 'Remove attachment', type: 'button' },
			});
			setIcon(removeBtn, 'x');
			const idx = i;
			removeBtn.onclick = (e) => {
				e.stopPropagation();
				this.stagedMedia.splice(idx, 1);
				this.renderMediaTray();
				this.updateSendButtonState();
			};
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
		if (this.isPlusMenuOpen) {
			this.closeAutocompleteMenu();
		} else {
			this.isPlusMenuOpen = true;
			this.isMenuDismissed = false;
			this.renderAutocomplete('at', '');
		}
	}

	private checkAndRenderAutocomplete(): void {
		if (this.isMenuDismissed) {
			this.closeAutocompleteMenu();
			return;
		}

		const token = this.parseToken(this.inputEl.value);
		if (!token) {
			if (this.isPlusMenuOpen) {
				this.renderAutocomplete('at', '');
			} else {
				this.closeAutocompleteMenu();
			}
			return;
		}

		this.renderAutocomplete(token.kind, token.query);
	}

	private getItems(kind: 'at' | 'slash', query: string): AutocompleteItem[] {
		if (kind === 'slash') {
			return DEFAULT_SLASH_COMMANDS.filter((c) =>
				c.name.slice(1).toLowerCase().startsWith(query),
			);
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

		// Vault Markdown files matching query
		const allFiles = this.app.vault.getMarkdownFiles();
		for (const file of allFiles) {
			const noteName = file.basename;
			if (query && !noteName.toLowerCase().includes(query)) {
				continue;
			}
			// Avoid duplicating active note
			if (ctx.activeFile && file.path === ctx.activeFile) continue;

			items.push({
				key: file.path,
				name: noteName,
				desc: file.parent ? file.parent.path : 'Vault root',
				icon: 'file',
				type: 'file',
			});

			if (items.length >= 8) break;
		}

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

		// Gliding highlight element
		this.gliderEl = this.menuContainerEl.createSpan({
			cls: 'anti-dian-promptbar-glider',
			attr: { 'aria-hidden': 'true' },
		});

		const listEl = this.menuContainerEl.createDiv({
			cls: 'anti-dian-promptbar-menu-list',
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

				rowBtn.createSpan({
					cls: 'anti-dian-promptbar-menu-name',
					text: item.type === 'command' ? item.name : `@${item.name}`,
				});

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
			this.callbacks.onStartNewSession?.();
			this.closeAutocompleteMenu();
			this.inputEl.focus();
			return;
		}

		if (kind === 'at') {
			const prefix = token ? currentVal.slice(0, token.start) : currentVal;
			this.inputEl.value = `${prefix}@${item.name} `;
		} else {
			const prefix = token ? currentVal.slice(0, token.start) : currentVal;
			this.inputEl.value = `${prefix}${item.name} `;
		}

		this.closeAutocompleteMenu();
		this.adjustTextareaHeight();
		this.updateSendButtonState();
		this.inputEl.focus();
	}

	public closeAutocompleteMenu(): void {
		if (this.menuContainerEl) {
			this.menuContainerEl.remove();
			this.menuContainerEl = null;
		}
		this.isPlusMenuOpen = false;
		this.menuRowEls = [];
	}
}
