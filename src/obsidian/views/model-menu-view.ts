import { Menu, MenuItem, setIcon } from 'obsidian';
import {
	AccountTierInfo,
	AvailableModel,
	CachedQuotaSnapshot,
	ContextWindowUsage,
	ModelGroup,
	ModelVariant,
	UserQuotaResponse,
	formatTokens,
	groupModels,
} from '../../core/models/antigravity-acp';
import { attachNativeMenuGlider } from './menu-glider';

interface UsageRow {
	title: string;
	detail?: string;
	value: string;
	/** Omitted for plain counts that have no limit to measure against. */
	bar?: { pct: number; status: 'normal' | 'warning' | 'error' };
}

export interface ModelMenuContext {
	getCurrentModelId: () => string;
	onSelectModel: (modelId: string) => void;
	getAvailableModels: () => AvailableModel[];
	getModelGroups: () => ModelGroup[];
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

/** `MenuItem.setSubmenu` exists at runtime but is not in the public typings. */
type MenuItemWithSubmenu = MenuItem & { setSubmenu?: () => Menu };

/** `Menu.dom` / `MenuItem.dom` exist at runtime but are not in the public typings. */
type MenuWithDom = Menu & { dom?: HTMLElement };
type MenuItemWithDom = MenuItem & { dom?: HTMLElement };

const SUPPORTS_SUBMENU =
	typeof (MenuItem.prototype as MenuItemWithSubmenu).setSubmenu === 'function';

const DEFAULT_MODEL_ID = 'gemini-3.7-flash-high';

export class ModelMenuController {
	private ctx: ModelMenuContext;
	private menu: Menu | null = null;
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

	formatModelLabel(modelId?: string): string {
		const currentId = modelId || this.ctx.getCurrentModelId() || DEFAULT_MODEL_ID;
		const groups = this.ctx.getModelGroups();

		const group = groups.find((g) =>
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

		const currentModelId = this.ctx.getCurrentModelId() || DEFAULT_MODEL_ID;
		const groups =
			this.ctx.getModelGroups().length > 0
				? this.ctx.getModelGroups()
				: groupModels(this.ctx.getAvailableModels());

		const menu = new Menu();
		(menu as MenuWithDom).dom?.addClass('anti-dian-model-menu');
		attachNativeMenuGlider(menu);
		menu.addItem((item) => item.setTitle('Model').setIsLabel(true));

		for (const group of groups) {
			const activeVariant = group.variants.find((v) => v.id === currentModelId);
			const title = this.groupTitle(group, activeVariant);

			if (group.variants.length > 1 && SUPPORTS_SUBMENU) {
				menu.addItem((item) => {
					item.setTitle(title).setChecked(activeVariant !== undefined);
					const submenu = (item as MenuItemWithSubmenu).setSubmenu?.();
					if (!submenu) return;
					(submenu as MenuWithDom).dom?.addClass('anti-dian-model-menu');
					attachNativeMenuGlider(submenu);
					submenu.addItem((sub) => sub.setTitle('Thinking effort').setIsLabel(true));
					for (const variant of group.variants) {
						submenu.addItem((sub) =>
							sub
								.setTitle(variant.thinkingEffort)
								.setChecked(variant.id === currentModelId)
								.onClick(() => this.ctx.onSelectModel(variant.id)),
						);
					}
				});
			} else if (group.variants.length > 1) {
				// No submenu support: list each effort as its own item.
				for (const variant of group.variants) {
					menu.addItem((item) =>
						item
							.setTitle(`${group.baseName} · ${variant.thinkingEffort}`)
							.setChecked(variant.id === currentModelId)
							.onClick(() => this.ctx.onSelectModel(variant.id)),
					);
				}
			} else {
				const variant = group.variants[0];
				menu.addItem((item) =>
					item
						.setTitle(title)
						.setChecked(activeVariant !== undefined)
						.setDisabled(!variant)
						.onClick(() => {
							if (variant) this.ctx.onSelectModel(variant.id);
						}),
				);
			}
		}

		menu.addSeparator();
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

		// Hovering "View Usage" shows the usage panel beside the menu, like a submenu;
		// hovering any other item closes it again.
		const menuEl = (menu as MenuWithDom).dom;
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
			if (this.menu === menu) this.menu = null;
			this.menuHiddenAt = Date.now();
			// Keep a hover panel only while the pointer is on it (e.g. clicking inside it).
			if (this.usagePanelFromHover && !this.usagePanelEl?.matches(':hover')) {
				this.closeUsagePanel();
			}
		});

		this.menu = menu;
		this.menuAnchorEl = anchorEl;
		const rect = anchorEl.getBoundingClientRect();
		menu.showAtPosition(
			{ x: rect.left, y: rect.bottom + 4, width: rect.width },
			anchorEl.doc,
		);
	}

	private groupTitle(group: ModelGroup, activeVariant?: ModelVariant): DocumentFragment {
		const frag = createFragment();
		frag.appendText(group.baseName);
		const effort =
			activeVariant && activeVariant.thinkingEffort !== 'Default'
				? activeVariant.thinkingEffort
				: group.variants.length <= 1 && group.supportsThinking
					? 'Thinking'
					: null;
		if (effort) {
			frag.createSpan({ cls: 'anti-dian-menu-item-effort', text: effort });
		}
		if (group.baseName.includes('3.6') || group.baseName.includes('3.5')) {
			this.appendBadge(frag, 'Fast', 'Faster, lighter model');
		}
		return frag;
	}

	/** Pill badge after a model name; a tooltip adds a trailing info icon. */
	private appendBadge(frag: DocumentFragment, text: string, tooltip?: string): void {
		const badge = frag.createSpan({ cls: 'anti-dian-menu-item-badge', text });
		if (!tooltip) return;
		badge.setAttribute('aria-label', tooltip);
		const info = badge.createSpan({ cls: 'anti-dian-menu-item-badge-info' });
		setIcon(info, 'info');
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
		const accountSec = panel.createDiv({
			cls: 'anti-dian-usage-section anti-dian-usage-account-section',
		});
		const accountHeader = accountSec.createDiv({
			cls: 'anti-dian-usage-account-header',
		});
		const userCol = accountHeader.createDiv({
			cls: 'anti-dian-usage-user-col',
		});
		const tierRow = userCol.createDiv({
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
			const loadingSec = panel.createDiv({
				cls: 'anti-dian-usage-section',
			});
			loadingSec.createDiv({
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
			text: 'Session Token Usage (Live)',
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
