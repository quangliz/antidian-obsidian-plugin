import { setIcon } from 'obsidian';
import {
	AccountTierInfo,
	AvailableModel,
	ModelGroup,
	groupModels,
} from '../../core/models/antigravity-acp';

export interface ModelMenuContext {
	getCurrentModelId: () => string;
	onSelectModel: (modelId: string) => void;
	getAvailableModels: () => AvailableModel[];
	getModelGroups: () => ModelGroup[];
	getAccountTier: () => AccountTierInfo | null;
	getSessionStats: () => {
		promptTokens: number;
		candidateTokens: number;
		totalTokens: number;
	};
}

export class ModelMenuController {
	private ctx: ModelMenuContext;
	private modelMenuEl: HTMLElement | null = null;
	private effortSubmenuEl: HTMLElement | null = null;
	private usageSubmenuEl: HTMLElement | null = null;
	private isModelMenuOpen = false;
	private isUsageSubmenuOpen = false;

	constructor(ctx: ModelMenuContext) {
		this.ctx = ctx;
	}

	isOpen(): boolean {
		return this.isModelMenuOpen;
	}

	formatModelLabel(modelId?: string): string {
		const currentId = modelId || this.ctx.getCurrentModelId() || 'gemini-3.7-flash-high';
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
		if (this.isModelMenuOpen) {
			this.closeMenu();
		} else {
			this.openMenu(anchorEl);
		}
	}

	openMenu(anchorEl: HTMLElement): void {
		this.closeMenu();
		this.isModelMenuOpen = true;

		this.modelMenuEl = document.body.createDiv({
			cls: 'anti-dian-model-menu',
		});

		this.modelMenuEl.createDiv({
			cls: 'anti-dian-menu-header',
			text: 'Model',
		});

		const currentModelId = this.ctx.getCurrentModelId() || 'gemini-3.7-flash-high';
		const available = this.ctx.getAvailableModels();
		const groups =
			this.ctx.getModelGroups().length > 0
				? this.ctx.getModelGroups()
				: groupModels(available);

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
						this.ctx.onSelectModel(group.variants[0].id);
						this.closeMenu();
					}
				};
			}
		}

		this.modelMenuEl.createDiv({ cls: 'anti-dian-menu-divider' });

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

		this.positionMenu(anchorEl, this.modelMenuEl);
	}

	openEffortSubmenu(anchorEl: HTMLElement, group: ModelGroup): void {
		this.closeEffortSubmenu();

		this.effortSubmenuEl = document.body.createDiv({
			cls: 'anti-dian-effort-popup',
		});

		const currentModelId = this.ctx.getCurrentModelId() || 'gemini-3.7-flash-high';

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
				this.ctx.onSelectModel(variant.id);
				this.closeMenu();
			};
		}

		this.positionSubmenu(anchorEl, this.effortSubmenuEl);
	}

	closeEffortSubmenu(): void {
		if (this.effortSubmenuEl) {
			this.effortSubmenuEl.remove();
			this.effortSubmenuEl = null;
		}
	}

	toggleUsageSubmenu(anchorEl: HTMLElement): void {
		if (this.isUsageSubmenuOpen) {
			this.closeUsageSubmenu();
		} else {
			void this.openUsageSubmenu(anchorEl);
		}
	}

	openUsageSubmenu(anchorEl: HTMLElement): void {
		this.closeUsageSubmenu();
		this.closeEffortSubmenu();
		this.isUsageSubmenuOpen = true;

		this.usageSubmenuEl = document.body.createDiv({
			cls: 'anti-dian-usage-popup',
		});

		const tier = this.ctx.getAccountTier();
		const accountSec = this.usageSubmenuEl.createDiv({
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

		this.usageSubmenuEl.createDiv({ cls: 'anti-dian-menu-divider' });

		const sessionSec = this.usageSubmenuEl.createDiv({
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

	closeUsageSubmenu(): void {
		if (this.usageSubmenuEl) {
			this.usageSubmenuEl.remove();
			this.usageSubmenuEl = null;
		}
		this.isUsageSubmenuOpen = false;
	}

	closeMenu(): void {
		this.closeEffortSubmenu();
		this.closeUsageSubmenu();
		if (this.modelMenuEl) {
			this.modelMenuEl.remove();
			this.modelMenuEl = null;
		}
		this.isModelMenuOpen = false;
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
}
