import { Menu, MenuItem, setIcon } from 'obsidian';
import {
	AccountTierInfo,
	CachedQuotaSnapshot,
	ContextWindowUsage,
	ModelConfig,
	ModelSelect,
	UserQuotaResponse,
	formatTokens,
} from '../../core/models/antigravity-acp';
import { EffortSlider } from './effort-slider';
import { attachNativeMenuGlider } from './menu-glider';

interface UsageRow {
	title: string;
	detail?: string;
	value: string;
	/** Omitted for plain counts that have no limit to measure against. */
	bar?: { pct: number; status: 'normal' | 'warning' | 'error' };
}

export interface ModelMenuContext {
	getModelConfig: () => ModelConfig | null;
	onSelectModel: (model: string) => void;
	onSelectThoughtLevel: (level: string) => void;
	getAccountTier: () => AccountTierInfo | null;
	getCachedUserQuota: () => CachedQuotaSnapshot | null;
	fetchUserQuota: () => Promise<UserQuotaResponse | null>;
	getContextUsage: () => ContextWindowUsage | null;
	getSessionStats: () => {
		promptTokens: number;
		candidateTokens: number;
		totalTokens: number;
		cachedReadTokens: number;
		thoughtTokens: number;
	};
}

/** `Menu.dom` / `MenuItem.dom` exist at runtime but are not in the public typings. */
type MenuWithDom = Menu & { dom?: HTMLElement };
type MenuItemWithDom = MenuItem & { dom?: HTMLElement };

/** Name of the selected option; the raw value when it is not listed. */
function selectedName(select: ModelSelect): string {
	return (
		select.options.find((o) => o.value === select.current)?.name ?? select.current
	);
}

export class ModelMenuController {
	private ctx: ModelMenuContext;
	private menu: Menu | null = null;
	private modelRows = new Map<string, HTMLElement>();
	private effortSlider: EffortSlider | null = null;
	private effortItem: MenuItem | null = null;
	private menuAnchorEl: HTMLElement | null = null;
	private menuHiddenAt = 0;
	private usagePanelEl: HTMLElement | null = null;
	/** True when the usage panel was opened by hovering "View Usage" (tied to the menu). */
	private usagePanelFromHover = false;

	constructor(ctx: ModelMenuContext) {
		this.ctx = ctx;
	}

	/** True while the custom usage panel is open (the native menu manages itself). */
	isOpen(): boolean {
		return this.usagePanelEl !== null;
	}

	formatModelLabel(): { name: string; effort?: string } {
		const config = this.ctx.getModelConfig();
		if (!config) return { name: 'Model' };
		return {
			name: selectedName(config.model),
			effort: config.thoughtLevel && selectedName(config.thoughtLevel),
		};
	}

	toggleMenu(anchorEl: HTMLElement): void {
		if (this.usagePanelEl) {
			this.closeMenu();
			return;
		}
		// The native menu hides itself on the pointerdown that precedes this click;
		// treat a click on the same anchor right after that as "close", not "reopen".
		if (this.menuAnchorEl === anchorEl && Date.now() - this.menuHiddenAt < 300) {
			return;
		}
		this.openMenu(anchorEl);
	}

	openMenu(anchorEl: HTMLElement): void {
		this.closeMenu();

		const config = this.ctx.getModelConfig();
		// The effort bar needs a DOM menu (macOS uses native menus by default).
		const menu = new Menu().setUseNativeMenu(false);
		(menu as MenuWithDom).dom?.addClass('anti-dian-model-menu');
		attachNativeMenuGlider(menu);
		let releaseKeys: (() => void) | undefined;
		this.modelRows.clear();
		this.effortSlider = null;
		this.effortItem = null;
		if (config) {
			this.addModels(menu, config.model);
			menu.addSeparator();
			// Ends with a divider of its own.
			const slider = new EffortSlider(
				config.thoughtLevel,
				this.ctx.onSelectThoughtLevel,
			);
			const title = createFragment();
			title.append(slider.el);
			menu.addItem((item) => {
				// Arrow keys skip the row while it is collapsed.
				item.setTitle(title).setDisabled(!config.thoughtLevel);
				(item as MenuItemWithDom).dom?.addClass('anti-dian-effort-item');
				this.effortItem = item;
			});
			this.effortSlider = slider;
			releaseKeys = this.bindSliderKeys(slider, anchorEl.win);
		} else {
			menu.addItem((item) => item.setTitle('Loading models...').setIsLabel(true));
			menu.addSeparator();
		}

		let usageItemEl: HTMLElement | undefined;
		menu.addItem((item) => {
			item
				.setTitle(this.viewUsageTitle())
				.setIcon('gauge')
				.onClick(() => {
					void this.openUsagePanel(anchorEl);
				});
			usageItemEl = (item as MenuItemWithDom).dom;
		});

		const menuEl = (menu as MenuWithDom).dom;
		// Keep the menu open after a click on a model, to set its effort next.
		menuEl?.addEventListener(
			'click',
			(evt) => {
				const itemEl = (evt.target as HTMLElement | null)?.closest('.menu-item');
				for (const [model, row] of this.modelRows) {
					if (!itemEl?.contains(row)) continue;
					evt.stopPropagation();
					this.ctx.onSelectModel(model);
				}
			},
			true,
		);
		// Hovering "View Usage" shows the usage panel beside the menu, like a submenu;
		// hovering any other item closes it again.
		menuEl?.addEventListener('mouseover', (evt) => {
			const target = evt.target as HTMLElement | null;
			const itemEl = target?.closest('.menu-item');
			if (!itemEl) return;
			if (itemEl === usageItemEl) {
				if (!this.usagePanelEl) void this.openUsagePanel(usageItemEl, true);
			} else if (this.usagePanelFromHover) {
				this.closeUsagePanel();
			}
		});

		menu.onHide(() => {
			releaseKeys?.();
			if (this.menu === menu) this.menu = null;
			this.menuHiddenAt = Date.now();
			// Keep a hover panel only while the pointer is on it (e.g. clicking inside it).
			if (this.usagePanelFromHover && !this.usagePanelEl?.matches(':hover')) {
				this.closeUsagePanel();
			}
		});

		if (menuEl) {
			new ResizeObserver(() => this.keepOnScreen(menuEl)).observe(menuEl);
		}

		this.menu = menu;
		this.menuAnchorEl = anchorEl;
		const rect = anchorEl.getBoundingClientRect();
		menu.showAtPosition(
			{ x: rect.left, y: rect.bottom + 4, width: rect.width },
			anchorEl.doc,
		);
	}

	/** Shows the current choices in the open menu. */
	refresh(): void {
		const config = this.ctx.getModelConfig();
		if (!this.menu || !config) return;
		for (const [model, row] of this.modelRows) {
			row.toggleClass('is-current', model === config.model.current);
		}
		this.effortSlider?.update(config.thoughtLevel);
		this.effortItem?.setDisabled(!config.thoughtLevel);
	}

	/** The menu grows when the new model has an effort bar and the last one had none. */
	private keepOnScreen(dom: HTMLElement): void {
		const overflow = dom.offsetTop + dom.offsetHeight - dom.win.innerHeight;
		if (overflow <= 0) return;
		dom.setCssProps({ top: `${Math.max(0, dom.offsetTop - overflow)}px` });
	}

	private addModels(menu: Menu, models: ModelSelect): void {
		menu.addItem((item) => item.setTitle('Model').setIsLabel(true));
		for (const option of models.options) {
			const title = createFragment();
			const row = title.createSpan({
				cls: 'anti-dian-model-row',
				text: option.name,
			});
			row.toggleClass('is-current', option.value === models.current);
			// Not `setChecked`: Obsidian does not bring a removed check mark back.
			setIcon(row.createSpan({ cls: 'anti-dian-model-row-check' }), 'check');
			this.modelRows.set(option.value, row);
			// Enter closes the menu; a click does not reach this (see openMenu).
			menu.addItem((item) =>
				item
					.setTitle(title)
					.onClick(() => this.ctx.onSelectModel(option.value)),
			);
		}
	}

	/**
	 * ←/→ move the effort bar while its row is selected. The menu's key scope swallows
	 * the keys before they reach the range input, so listen next to it on the window.
	 */
	private bindSliderKeys(slider: EffortSlider, win: Window): () => void {
		const onKeydown = (evt: KeyboardEvent): void => {
			if (evt.key !== 'ArrowLeft' && evt.key !== 'ArrowRight') return;
			if (!slider.el.closest('.menu-item.selected')) return;
			slider.step(evt.key === 'ArrowRight' ? 1 : -1);
		};
		win.addEventListener('keydown', onKeydown, true);
		return () => win.removeEventListener('keydown', onKeydown, true);
	}

	private viewUsageTitle(): DocumentFragment {
		const frag = createFragment();
		frag.appendText('View Usage');
		const chevron = frag.createSpan({ cls: 'anti-dian-menu-item-chevron' });
		setIcon(chevron, 'chevron-right');
		return frag;
	}

	async openUsagePanel(anchorEl: HTMLElement, beside = false): Promise<void> {
		this.closeUsagePanel();

		const panel = anchorEl.doc.body.createDiv({
			cls: 'anti-dian-usage-popup',
		});
		this.usagePanelEl = panel;
		this.usagePanelFromHover = beside;
		const position = () =>
			beside ? this.positionPanelBeside(anchorEl, panel) : this.positionPanel(anchorEl, panel);

		const cached = this.ctx.getCachedUserQuota();
		const needsRefresh = !cached || cached.isStale;

		this.renderUsagePanelContent(
			panel,
			cached?.data ?? null,
			needsRefresh && !cached,
		);
		position();

		if (!needsRefresh) {
			return;
		}

		const freshQuota = await this.ctx.fetchUserQuota();
		if (this.usagePanelEl !== panel) return;
		this.renderUsagePanelContent(panel, freshQuota ?? cached?.data ?? null, false);
		position();
	}

	private renderUsagePanelContent(
		panel: HTMLElement,
		quotaData: UserQuotaResponse | null,
		isLoadingQuota: boolean,
	): void {
		panel.empty();

		const tier = quotaData?.accountTier ?? this.ctx.getAccountTier();
		const tierRow = panel.createDiv({
			cls: 'anti-dian-usage-tier-row',
		});
		tierRow.createSpan({
			text: tier?.tierName || 'Antigravity CLI (ACP)',
			cls: 'anti-dian-usage-tier-badge',
		});
		if (tier?.tierId === 'free-tier') {
			tierRow.createSpan({
				text: 'Free',
				cls: 'anti-dian-usage-tier-tag',
			});
		}

		const groups = quotaData?.groups ?? [];
		if (isLoadingQuota && groups.length === 0) {
			panel.createDiv({ cls: 'anti-dian-menu-divider' });
			panel
				.createDiv({ cls: 'anti-dian-usage-row' })
				.createSpan({
					text: 'Loading quota limits...',
					cls: 'anti-dian-usage-row-detail',
				});
		}

		for (const group of groups) {
			panel.createDiv({ cls: 'anti-dian-menu-divider' });

			const groupSec = panel.createDiv({
				cls: 'anti-dian-usage-section',
			});
			groupSec.createDiv({
				text: group.name,
				cls: 'anti-dian-usage-sec-title',
			});

			for (const bucket of group.buckets) {
				const remainingPct = bucket.remainingFraction * 100;
				this.renderUsageRow(groupSec, {
					// The value already says "left", so drop the suffix the CLI puts in the name.
					title: bucket.name.replace(/\s+remaining$/i, ''),
					detail: this.formatResetDetail(bucket.resetTime, bucket.remainingFraction),
					value: `${Math.round(remainingPct)}% left`,
					bar: {
						pct: remainingPct,
						status:
							bucket.remainingFraction < 0.15
								? 'error'
								: bucket.remainingFraction < 0.3
									? 'warning'
									: 'normal',
					},
				});
			}
		}

		panel.createDiv({ cls: 'anti-dian-menu-divider' });

		const sessionSec = panel.createDiv({
			cls: 'anti-dian-usage-section',
		});
		sessionSec.createDiv({
			text: 'This session',
			cls: 'anti-dian-usage-sec-title',
		});

		const stats = this.ctx.getSessionStats();
		this.renderUsageRow(sessionSec, {
			title: 'Tokens processed',
			detail:
				stats.totalTokens > 0
					? `${stats.promptTokens.toLocaleString()} in / ${stats.candidateTokens.toLocaleString()} out`
					: undefined,
			value: stats.totalTokens.toLocaleString(),
		});

		if (stats.cachedReadTokens > 0 && stats.promptTokens > 0) {
			const cachedPct = (stats.cachedReadTokens / stats.promptTokens) * 100;
			this.renderUsageRow(sessionSec, {
				title: 'Cached input',
				detail: `${formatTokens(stats.cachedReadTokens)} / ${formatTokens(stats.promptTokens)}`,
				value: `${Math.round(cachedPct)}%`,
				bar: { pct: cachedPct, status: 'normal' },
			});
		}
		if (stats.thoughtTokens > 0) {
			this.renderUsageRow(sessionSec, {
				title: 'Thinking tokens',
				value: stats.thoughtTokens.toLocaleString(),
			});
		}

		const ctxUsage = this.ctx.getContextUsage();
		if (ctxUsage && ctxUsage.size > 0) {
			const usedPct = Math.min(100, (ctxUsage.used / ctxUsage.size) * 100);
			this.renderUsageRow(sessionSec, {
				title: 'Context window',
				detail: `${formatTokens(ctxUsage.used) || '0'} / ${formatTokens(ctxUsage.size)}`,
				value: `${Math.round(usedPct)}%`,
				bar: {
					pct: usedPct,
					status: usedPct > 85 ? 'error' : usedPct > 65 ? 'warning' : 'normal',
				},
			});
		}
	}

	/** "Resets at 4:10 PM" today, "Resets Sun 8:00 PM" on another day; nothing for an unused window. */
	private formatResetDetail(
		resetTime: string | undefined,
		remainingFraction: number,
	): string | undefined {
		if (!resetTime || remainingFraction >= 0.999) return undefined;
		const reset = new Date(resetTime);
		const now = new Date();
		if (!(reset.getTime() > now.getTime())) return 'Refreshing soon';
		const time = reset.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
		if (reset.toDateString() === now.toDateString()) return `Resets at ${time}`;
		return `Resets ${reset.toLocaleDateString([], { weekday: 'short' })} ${time}`;
	}

	private renderUsageRow(parent: HTMLElement, opts: UsageRow): void {
		const row = parent.createDiv({ cls: 'anti-dian-usage-row' });
		const label = row.createDiv({ cls: 'anti-dian-usage-row-label' });
		label.createSpan({ text: opts.title, cls: 'anti-dian-usage-row-title' });
		if (opts.detail) {
			label.createSpan({ text: opts.detail, cls: 'anti-dian-usage-row-detail' });
		}
		label.createSpan({ text: opts.value, cls: 'anti-dian-usage-row-value' });

		if (opts.bar) {
			const bar = row.createDiv({ cls: `anti-dian-usage-bar is-${opts.bar.status}` });
			bar.createDiv({ cls: 'anti-dian-usage-bar-fill' }).setCssProps({
				'--anti-dian-usage-pct': `${opts.bar.pct}%`,
			});
		}
	}

	closeUsagePanel(): void {
		this.usagePanelEl?.remove();
		this.usagePanelEl = null;
		this.usagePanelFromHover = false;
	}

	closeMenu(): void {
		this.menu?.hide();
		this.menu = null;
		this.closeUsagePanel();
	}

	/** Place the panel to the right of a menu item (left if no room), like a submenu. */
	private positionPanelBeside(itemEl: HTMLElement, panel: HTMLElement): void {
		const win = itemEl.win;
		const menuRect = (itemEl.closest('.menu') ?? itemEl).getBoundingClientRect();
		const itemRect = itemEl.getBoundingClientRect();
		const height = panel.offsetHeight || 380;
		const width = panel.offsetWidth || 270;

		let left = menuRect.right + 4;
		if (left + width > win.innerWidth - 10) {
			left = Math.max(10, menuRect.left - width - 4);
		}
		let top = itemRect.top - 6;
		if (top + height > win.innerHeight - 10) {
			top = Math.max(10, win.innerHeight - height - 10);
		}

		panel.setCssProps({ left: `${left}px`, top: `${top}px` });
	}

	private positionPanel(anchor: HTMLElement, panel: HTMLElement): void {
		const win = anchor.win;
		const anchorRect = anchor.getBoundingClientRect();
		const height = panel.offsetHeight || 380;
		const width = panel.offsetWidth || 260;

		const spaceBelow = win.innerHeight - anchorRect.bottom - 10;
		const spaceAbove = anchorRect.top - 10;

		let top = anchorRect.bottom + 6;
		if (spaceBelow < height && spaceAbove > spaceBelow) {
			top = Math.max(10, anchorRect.top - height - 6);
		}

		let left = anchorRect.left;
		if (left + width > win.innerWidth - 10) {
			left = Math.max(10, win.innerWidth - width - 10);
		}

		panel.setCssProps({
			left: `${left}px`,
			top: `${top}px`,
		});
	}
}
