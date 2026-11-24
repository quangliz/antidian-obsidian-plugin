import { Menu, MenuItem } from 'obsidian';
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

const SUPPORTS_SUBMENU =
	typeof (MenuItem.prototype as MenuItemWithSubmenu).setSubmenu === 'function';

const DEFAULT_MODEL_ID = 'gemini-3.7-flash-high';

export class ModelMenuController {
	private ctx: ModelMenuContext;
	private menu: Menu | null = null;
	private menuAnchorEl: HTMLElement | null = null;
	private menuHiddenAt = 0;
	private usagePanelEl: HTMLElement | null = null;

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
		menu.addItem((item) => item.setTitle('Model').setIsLabel(true));

		for (const group of groups) {
			const activeVariant = group.variants.find((v) => v.id === currentModelId);
			const title = this.groupTitle(group, activeVariant);

			if (group.variants.length > 1 && SUPPORTS_SUBMENU) {
				menu.addItem((item) => {
					item.setTitle(title).setChecked(activeVariant !== undefined);
					const submenu = (item as MenuItemWithSubmenu).setSubmenu?.();
					if (!submenu) return;
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
		menu.addItem((item) =>
			item
				.setTitle('View usage')
				.setIcon('activity')
				.onClick(() => {
					void this.openUsagePanel(anchorEl);
				}),
		);

		menu.onHide(() => {
			if (this.menu === menu) this.menu = null;
			this.menuHiddenAt = Date.now();
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
			frag.createSpan({ cls: 'anti-dian-menu-item-badge', text: 'Fast' });
		}
		return frag;
	}

	async openUsagePanel(anchorEl: HTMLElement): Promise<void> {
		this.closeUsagePanel();

		const panel = anchorEl.doc.body.createDiv({
			cls: 'anti-dian-usage-popup',
		});
		this.usagePanelEl = panel;

		const cached = this.ctx.getCachedUserQuota();
		const needsRefresh = !cached || cached.isStale;

		this.renderUsagePanelContent(
			panel,
			cached?.data ?? null,
			needsRefresh && !cached,
		);
		this.positionPanel(anchorEl, panel);

		if (!needsRefresh) {
			return;
		}

		const freshQuota = await this.ctx.fetchUserQuota();
		if (this.usagePanelEl !== panel) return;
		this.renderUsagePanelContent(panel, freshQuota ?? cached?.data ?? null, false);
		this.positionPanel(anchorEl, panel);
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
		if (tier?.tierId) {
			tierRow.createSpan({
				text: tier.tierId === 'free-tier' ? 'Free' : tier.tierId,
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
				cls: 'anti-dian-usage-limit-subtext',
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
				const pct = `${Math.round(bucket.remainingFraction * 100)}%`;
				const status: 'success' | 'warning' | 'error' =
					bucket.remainingFraction < 0.15
						? 'error'
						: bucket.remainingFraction < 0.3
							? 'warning'
							: 'success';

				const subtext = this.formatResetSubtext(
					bucket.resetTime,
					bucket.window,
					bucket.remainingFraction,
				);

				this.renderUsageLimitRow(
					groupSec,
					bucket.name,
					pct,
					subtext,
					status,
				);
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
		this.renderUsageLimitRow(
			sessionSec,
			'Session Tokens Processed',
			stats.totalTokens.toLocaleString(),
			`${stats.promptTokens.toLocaleString()} in / ${stats.candidateTokens.toLocaleString()} out`,
			'success',
		);

		if (stats.cachedReadTokens > 0 && stats.promptTokens > 0) {
			const cachedPct = Math.round((stats.cachedReadTokens / stats.promptTokens) * 100);
			this.renderUsageLimitRow(
				sessionSec,
				'Cached Input',
				`${cachedPct}%`,
				`${stats.cachedReadTokens.toLocaleString()} of ${stats.promptTokens.toLocaleString()} input tokens from cache`,
				'success',
			);
		}
		if (stats.thoughtTokens > 0) {
			this.renderUsageLimitRow(
				sessionSec,
				'Thinking Tokens',
				formatTokens(stats.thoughtTokens),
				`${stats.thoughtTokens.toLocaleString()} reasoning tokens this session`,
				'success',
			);
		}

		const ctxUsage = this.ctx.getContextUsage();
		if (ctxUsage && ctxUsage.size > 0) {
			const usedPct = Math.min(
				100,
				Math.round((ctxUsage.used / ctxUsage.size) * 100),
			);
			const ctxStatus: 'success' | 'warning' | 'error' =
				usedPct > 85 ? 'error' : usedPct > 65 ? 'warning' : 'success';
			this.renderUsageLimitRow(
				sessionSec,
				'Context Window',
				`${usedPct}%`,
				`${formatTokens(ctxUsage.used)} / ${formatTokens(ctxUsage.size)}`,
				ctxStatus,
			);
		}
	}

	private formatResetSubtext(
		resetTime?: string,
		windowType?: string,
		remainingFraction?: number,
	): string | undefined {
		if (remainingFraction !== undefined && remainingFraction >= 0.999) {
			return windowType === '5h'
				? 'Full 5-hour window available'
				: 'Full weekly window available';
		}
		if (!resetTime) return undefined;
		const diffMs = new Date(resetTime).getTime() - Date.now();
		if (!Number.isFinite(diffMs) || diffMs <= 0) {
			return 'Refreshing soon';
		}
		const totalMins = Math.round(diffMs / 60_000);
		const days = Math.floor(totalMins / (60 * 24));
		const hours = Math.floor((totalMins % (60 * 24)) / 60);
		const mins = totalMins % 60;
		if (days > 0) {
			return `Resets in ${days}d ${hours}h`;
		}
		if (hours > 0) {
			return `Resets in ${hours}h ${mins}m`;
		}
		return `Resets in ${mins}m`;
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

	closeUsagePanel(): void {
		this.usagePanelEl?.remove();
		this.usagePanelEl = null;
	}

	closeMenu(): void {
		this.menu?.hide();
		this.menu = null;
		this.closeUsagePanel();
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
