import { Menu, setIcon, setTooltip } from 'obsidian';
import type { AcpSessionSummary } from '../../core/models/antigravity-acp';
import {
	MatchRange,
	type SessionForkRelation,
	type SessionTreeNode,
	UNTITLED_SESSION,
	buildSessionTree,
	formatForkedTitle,
	formatRelativeTime,
	searchSessions,
} from './session-format';
import { MenuGlider } from './menu-glider';

export interface SessionMenuOptions {
	/** Heading of the session list: this vault's sessions. */
	getVaultName: () => string;
	listSessions: () => Promise<AcpSessionSummary[]>;
	getCurrentSessionId: () => string | null;
	getSessionForks?: () => Record<string, SessionForkRelation>;
	getSessionTitles?: () => Record<string, string>;
	onSelectSession: (session: AcpSessionSummary) => void;
	onNewSession: () => void;
	onRenameSession?: (sessionId: string, newTitle: string) => void | Promise<void>;
	onDeleteSession?: (sessionId: string) => void | Promise<void>;
	/** Remembered drawer width in px (null = default). */
	loadDrawerWidth?: () => number | null;
	saveDrawerWidth?: (width: number | null) => void;
	/** Pinned session IDs, in display order. */
	getPinnedSessions?: () => string[];
	setPinnedSessions?: (ids: string[]) => void;
}

const MIN_DRAWER_WIDTH = 200;
/** Always leave this much of the sidebar visible next to the drawer. */
const DRAWER_EDGE_GAP = 40;

export interface SessionDrawerOpenOptions {
	/** Show and focus the search field (opened from the nav's search button). */
	search?: boolean;
}

type DrawerItem =
	| { kind: 'new'; el: HTMLElement }
	| { kind: 'session'; el: HTMLElement; session: AcpSessionSummary };

/** Sessions shown under the vault folder before "See all". */
const COLLAPSED_SESSION_COUNT = 6;

/**
 * Session drawer that slides in from the left of the sidebar: "New Conversation",
 * an optional search field, and this vault's stored sessions (newest first).
 */
export class SessionMenuController {
	private rootEl: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private glider: MenuGlider | null = null;
	private searchWrapEl: HTMLElement | null = null;
	private searchEl: HTMLInputElement | null = null;
	private items: DrawerItem[] = [];
	private activeIndex = -1;
	private sessions: AcpSessionSummary[] | null = null;
	private loading = false;
	private error: string | null = null;
	private loadToken = 0;
	private showAll = false;
	private collapsedParents = new Set<string>();
	private editingSessionId: string | null = null;
	private confirmDeleteSessionId: string | null = null;
	private triggerEl: HTMLElement | null = null;

	constructor(
		private hostEl: HTMLElement,
		private options: SessionMenuOptions,
	) {}

	isOpen(): boolean {
		return this.rootEl !== null;
	}

	toggle(triggerEl: HTMLElement, opts: SessionDrawerOpenOptions = {}): void {
		if (this.isOpen()) this.close();
		else this.open(triggerEl, opts);
	}

	open(triggerEl: HTMLElement, opts: SessionDrawerOpenOptions = {}): void {
		this.close();
		this.triggerEl = triggerEl;
		triggerEl.setAttribute('aria-expanded', 'true');
		triggerEl.addClass('is-active');
		this.showAll = false;

		const root = this.hostEl.createDiv({ cls: 'antidian-session-drawer' });
		this.rootEl = root;
		const backdrop = root.createDiv({ cls: 'antidian-session-drawer-backdrop' });
		backdrop.addEventListener('click', () => this.close());

		const panel = root.createDiv({
			cls: 'antidian-session-drawer-panel',
			attr: { role: 'dialog', 'aria-label': 'Conversations' },
		});
		panel.addEventListener('keydown', (e) => this.onKeyDown(e));
		this.setupResize(panel);

		const closeBtn = panel.createEl('button', {
			cls: 'antidian-session-drawer-close',
			attr: { 'aria-label': 'Close' },
		});
		setIcon(closeBtn, 'x');
		closeBtn.addEventListener('click', () => this.close());

		const newBtn = panel.createDiv({
			cls: 'antidian-session-new',
			attr: { role: 'button', tabindex: '-1' },
		});
		const newIcon = newBtn.createSpan({ cls: 'antidian-session-new-icon' });
		setIcon(newIcon, 'plus');
		newBtn.createSpan({ text: 'New Conversation' });
		this.items = [];
		this.bindItem({ kind: 'new', el: newBtn });

		this.searchWrapEl = panel.createDiv({ cls: 'antidian-session-search' });
		const searchIcon = this.searchWrapEl.createSpan({
			cls: 'antidian-session-search-icon',
		});
		setIcon(searchIcon, 'search');
		this.searchEl = this.searchWrapEl.createEl('input', {
			type: 'text',
			cls: 'antidian-session-search-input',
			attr: { placeholder: 'Search conversations', spellcheck: 'false' },
		});
		this.searchEl.addEventListener('input', () => {
			this.activeIndex = -1;
			this.renderList();
		});
		this.searchWrapEl.toggleClass('antidian-hidden', !opts.search);

		panel.createDiv({ cls: 'antidian-session-section-label', text: 'Conversations' });

		this.listEl = panel.createDiv({
			cls: 'antidian-session-list',
			attr: { role: 'listbox' },
		});
		// Hide the highlight only when leaving the list, so it slides between rows
		// instead of vanishing in the gap between them.
		this.listEl.addEventListener('mouseleave', () => {
			if (this.items[this.activeIndex]?.kind === 'session') {
				this.activeIndex = -1;
				this.highlight();
			}
		});
		newBtn.addEventListener('mouseleave', () => {
			if (this.items[this.activeIndex]?.kind === 'new') {
				this.activeIndex = -1;
				this.highlight();
			}
		});

		this.renderList();
		window.setTimeout(() => {
			if (opts.search) this.searchEl?.focus();
			else panel.focus();
		}, 0);
		panel.setAttribute('tabindex', '-1');
		void this.refresh();
	}

	close(): void {
		this.loadToken++;
		if (this.rootEl) this.animateOut(this.rootEl);
		this.rootEl = null;
		this.listEl = null;
		this.glider = null;
		this.searchWrapEl = null;
		this.searchEl = null;
		this.items = [];
		this.activeIndex = -1;
		this.editingSessionId = null;
		this.confirmDeleteSessionId = null;
		if (this.triggerEl) {
			this.triggerEl.setAttribute('aria-expanded', 'false');
			this.triggerEl.removeClass('is-active');
			this.triggerEl = null;
		}
	}

	/** Drag handle on the panel's right edge; double-click resets the width. */
	private setupResize(panel: HTMLElement): void {
		const clamp = (width: number) => {
			const max = Math.max(MIN_DRAWER_WIDTH, this.hostEl.clientWidth - DRAWER_EDGE_GAP);
			return Math.round(Math.min(Math.max(width, MIN_DRAWER_WIDTH), max));
		};
		const apply = (width: number | null) => {
			panel.setCssProps({ width: width === null ? '' : `${clamp(width)}px` });
		};
		apply(this.options.loadDrawerWidth?.() ?? null);

		const handle = panel.createDiv({
			cls: 'antidian-session-drawer-resize',
			attr: { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize' },
		});
		handle.addEventListener('pointerdown', (e) => {
			if (e.button !== 0) return;
			e.preventDefault();
			handle.setPointerCapture(e.pointerId);
			const left = panel.getBoundingClientRect().left;
			const root = panel.closest('.antidian-session-drawer');
			root?.addClass('is-resizing');
			const onMove = (ev: PointerEvent) => apply(ev.clientX - left);
			const onUp = () => {
				handle.removeEventListener('pointermove', onMove);
				handle.removeEventListener('pointerup', onUp);
				handle.removeEventListener('pointercancel', onUp);
				root?.removeClass('is-resizing');
				this.options.saveDrawerWidth?.(clamp(panel.getBoundingClientRect().width));
			};
			handle.addEventListener('pointermove', onMove);
			handle.addEventListener('pointerup', onUp);
			handle.addEventListener('pointercancel', onUp);
		});
		handle.addEventListener('dblclick', () => {
			apply(null);
			this.options.saveDrawerWidth?.(null);
		});
	}

	/** Slide the panel back out and fade the backdrop, then remove the drawer. */
	private animateOut(root: HTMLElement): void {
		root.addClass('is-closing');
		const panel = root.querySelector('.antidian-session-drawer-panel');
		let removed = false;
		const remove = () => {
			if (removed) return;
			removed = true;
			root.remove();
		};
		panel?.addEventListener('animationend', remove, { once: true });
		// Fallback when animations are disabled (reduced motion, hidden view).
		window.setTimeout(remove, 260);
	}

	private async refresh(): Promise<void> {
		const token = ++this.loadToken;
		this.loading = true;
		this.error = null;
		this.renderList();
		try {
			const sessions = await this.options.listSessions();
			if (token !== this.loadToken) return;
			this.sessions = sessions;
		} catch (err) {
			if (token !== this.loadToken) return;
			this.error = err instanceof Error ? err.message : String(err);
		} finally {
			if (token === this.loadToken) {
				this.loading = false;
				this.renderList();
			}
		}
	}

	private renderList(): void {
		const list = this.listEl;
		if (!list) return;
		list.empty();
		this.glider = new MenuGlider(list);
		// Keep the "New Conversation" item; session rows are rebuilt.
		this.items = this.items.filter((item) => item.kind === 'new');

		const query = this.searchEl?.value.trim() ?? '';
		const all = this.sessions ?? [];
		const forks = this.options.getSessionForks?.() ?? {};
		const customTitles = this.options.getSessionTitles?.() ?? {};
		const currentId = this.options.getCurrentSessionId();

		const searchable = all.map((s) => ({
			...s,
			title: formatForkedTitle(s, forks[s.sessionId], customTitles[s.sessionId]),
		}));
		const hits = searchSessions(searchable, query);

		const roots = query ? [] : buildSessionTree(all, forks, customTitles);
		const nodesById = new Map<string, SessionTreeNode<AcpSessionSummary>>();
		const collect = (node: SessionTreeNode<AcpSessionSummary>): void => {
			nodesById.set(node.session.sessionId, node);
			node.children.forEach(collect);
		};
		roots.forEach(collect);
		const pinnedIds = this.getPinnedIds().filter((id) => nodesById.has(id));
		const pinnedSet = new Set(pinnedIds);
		const storedPins = new Set(this.getPinnedIds());

		// A pinned session's own forks stay under it; other pinned sessions are
		// listed once, in the pinned group, and skipped elsewhere.
		const renderNode = (
			node: SessionTreeNode<AcpSessionSummary>,
			depth: number,
		): void => {
			const children = node.children.filter((c) => !pinnedSet.has(c.session.sessionId));
			const hasChildren = children.length > 0;
			const isExpanded =
				hasChildren && !this.collapsedParents.has(node.session.sessionId);
			this.renderSessionRow(list, {
				session: node.session,
				displayTitle: node.displayTitle,
				ranges: [],
				isCurrent: node.session.sessionId === currentId,
				depth,
				hasChildren,
				isExpanded,
				isPinned: depth === 0 && pinnedSet.has(node.session.sessionId),
			});
			if (isExpanded) {
				for (const child of children) renderNode(child, depth + 1);
			}
		};

		if (!query && pinnedIds.length > 0) {
			list.createDiv({ cls: 'antidian-session-group-label', text: 'Pinned' });
			for (const id of pinnedIds) {
				const node = nodesById.get(id);
				if (node) renderNode(node, 0);
			}
		}

		const folder = list.createDiv({ cls: 'antidian-session-folder' });
		const folderIcon = folder.createSpan({ cls: 'antidian-session-folder-icon' });
		setIcon(folderIcon, 'folder-open');
		folder.createSpan({
			cls: 'antidian-session-folder-name',
			text: this.options.getVaultName(),
		});

		if (this.sessions === null && this.loading) {
			this.renderStatus(list, 'Loading…', true);
		} else if (this.error && all.length === 0) {
			this.renderStatus(list, `Couldn't load conversations: ${this.error}`);
		} else if (all.length === 0) {
			this.renderStatus(list, 'No conversations yet');
		} else if (hits.length === 0) {
			this.renderStatus(list, 'No matching conversations');
		}

		let collapsed = false;
		let totalCount = hits.length;

		if (query) {
			for (const { session, ranges } of hits) {
				this.renderSessionRow(list, {
					session,
					displayTitle: session.title ?? UNTITLED_SESSION,
					ranges,
					isCurrent: session.sessionId === currentId,
					depth: 0,
					hasChildren: false,
					isExpanded: false,
					isPinned: storedPins.has(session.sessionId),
				});
			}
		} else {
			const unpinned = roots.filter((r) => !pinnedSet.has(r.session.sessionId));
			totalCount = unpinned.length;
			collapsed = !this.showAll && unpinned.length > COLLAPSED_SESSION_COUNT;
			const visibleRoots = collapsed
				? unpinned.slice(0, COLLAPSED_SESSION_COUNT)
				: unpinned;

			for (const root of visibleRoots) {
				renderNode(root, 0);
			}
		}

		if (collapsed) {
			const seeAll = list.createDiv({
				cls: 'antidian-session-see-all',
				text: `See all (${totalCount})`,
				attr: { role: 'button' },
			});
			seeAll.addEventListener('mouseenter', () => {
				// Slide straight from the hovered row instead of hiding first.
				this.activeIndex = -1;
				this.items.forEach((item) => item.el.removeClass('is-highlighted'));
				this.glider?.moveTo(seeAll);
			});
			seeAll.addEventListener('click', (e) => {
				e.stopPropagation();
				this.showAll = true;
				this.renderList();
			});
		}

		// While searching, preselect the best match so Enter opens it.
		if (query && this.activeIndex === -1 && this.items.length > 1) this.activeIndex = 1;
		list.toggleClass('is-refreshing', this.loading && this.sessions !== null);
		if (this.activeIndex >= this.items.length) this.activeIndex = this.items.length - 1;
		this.highlight();
	}

	private renderSessionRow(
		list: HTMLElement,
		opts: {
			session: AcpSessionSummary;
			displayTitle: string;
			ranges: MatchRange[];
			isCurrent: boolean;
			depth: number;
			hasChildren: boolean;
			isExpanded: boolean;
			isPinned: boolean;
		},
	): void {
		const row = list.createDiv({
			cls: 'antidian-session-item',
			attr: { role: 'option', 'aria-selected': String(opts.isCurrent) },
		});
		if (opts.isCurrent) row.addClass('is-current');
		if (opts.isPinned) {
			row.addClass('is-pinned');
			const pinIcon = row.createSpan({ cls: 'antidian-session-pin-icon' });
			setIcon(pinIcon, 'pin');
		}
		if (opts.depth > 0) {
			row.addClass('is-child');
			row.setCssProps({
				'--antidian-session-depth': String(Math.min(opts.depth, 4)),
			});
		}

		const sessionId = opts.session.sessionId;
		const isEditing = this.editingSessionId === sessionId;
		const isConfirmingDelete = this.confirmDeleteSessionId === sessionId;
		if (isEditing) row.addClass('is-editing');
		if (isConfirmingDelete) row.addClass('is-confirming-delete');

		const titleWrap = row.createSpan({ cls: 'antidian-session-item-main' });
		if (isEditing) {
			const input = titleWrap.createEl('input', {
				type: 'text',
				cls: 'antidian-session-rename-input',
				value: opts.displayTitle,
				attr: { 'aria-label': 'Rename conversation', spellcheck: 'false' },
			});
			let settled = false;
			const commit = () => {
				if (settled) return;
				settled = true;
				const next = input.value.trim();
				this.editingSessionId = null;
				if (next && next !== opts.displayTitle) {
					void this.options.onRenameSession?.(sessionId, next);
				}
				this.renderList();
			};
			const cancel = () => {
				if (settled) return;
				settled = true;
				this.editingSessionId = null;
				this.renderList();
			};
			input.addEventListener('click', (e) => e.stopPropagation());
			input.addEventListener('keydown', (e) => {
				e.stopPropagation();
				if (e.key === 'Enter') {
					e.preventDefault();
					commit();
				} else if (e.key === 'Escape') {
					e.preventDefault();
					cancel();
				}
			});
			input.addEventListener('blur', () => commit());
			window.setTimeout(() => {
				input.focus();
				input.select();
			}, 0);
		} else {
			const titleEl = titleWrap.createSpan({
				cls: 'antidian-session-item-title',
				attr: { title: opts.displayTitle },
			});
			this.renderHighlighted(titleEl, opts.displayTitle, opts.ranges);

			if (opts.hasChildren) {
				const toggleBtn = titleWrap.createEl('button', {
					cls: 'antidian-session-chevron',
					attr: {
						type: 'button',
						'aria-label': opts.isExpanded ? 'Collapse forks' : 'Expand forks',
						'aria-expanded': String(opts.isExpanded),
					},
				});
				setIcon(toggleBtn, opts.isExpanded ? 'chevron-down' : 'chevron-right');
				toggleBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					if (this.collapsedParents.has(sessionId)) {
						this.collapsedParents.delete(sessionId);
					} else {
						this.collapsedParents.add(sessionId);
					}
					this.renderList();
				});
			}
		}

		const canRename = Boolean(this.options.onRenameSession);
		const canDelete = Boolean(this.options.onDeleteSession);
		// Forks are pinned via their own row only when they are top-level.
		const canPin = Boolean(this.options.setPinnedSessions) && opts.depth === 0;
		const togglePin = () => {
			const pinned = this.getPinnedIds();
			this.setPinnedIds(
				opts.isPinned
					? pinned.filter((id) => id !== sessionId)
					: [...pinned.filter((id) => id !== sessionId), sessionId],
			);
			this.renderList();
		};

		if (!isEditing) {
			if (isConfirmingDelete && canDelete) {
				const actions = row.createSpan({
					cls: 'antidian-session-actions is-visible',
				});
				const confirmBtn = actions.createEl('button', {
					cls: 'antidian-session-action-btn is-danger',
					attr: { type: 'button', 'aria-label': 'Confirm delete' },
				});
				setIcon(confirmBtn, 'check');
				setTooltip(confirmBtn, 'Confirm delete');
				confirmBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					this.confirmDeleteSessionId = null;
					this.sessions = (this.sessions ?? []).filter(
						(s) => s.sessionId !== sessionId,
					);
					void this.options.onDeleteSession?.(sessionId);
					this.renderList();
				});

				const cancelBtn = actions.createEl('button', {
					cls: 'antidian-session-action-btn',
					attr: { type: 'button', 'aria-label': 'Cancel delete' },
				});
				setIcon(cancelBtn, 'x');
				setTooltip(cancelBtn, 'Cancel');
				cancelBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					this.confirmDeleteSessionId = null;
					this.renderList();
				});
			} else {
				row.createSpan({
					cls: 'antidian-session-item-time',
					text: formatRelativeTime(opts.session.updatedAt),
				});

				if (canPin || canRename || canDelete) {
					const actions = row.createSpan({ cls: 'antidian-session-actions' });
					if (canPin) {
						const pinBtn = actions.createEl('button', {
							cls: 'antidian-session-action-btn',
							attr: {
								type: 'button',
								'aria-label': opts.isPinned ? 'Unpin conversation' : 'Pin conversation',
							},
						});
						setIcon(pinBtn, opts.isPinned ? 'pin-off' : 'pin');
						setTooltip(pinBtn, opts.isPinned ? 'Unpin' : 'Pin');
						pinBtn.addEventListener('click', (e) => {
							e.stopPropagation();
							togglePin();
						});
					}
					if (canRename) {
						const renameBtn = actions.createEl('button', {
							cls: 'antidian-session-action-btn',
							attr: { type: 'button', 'aria-label': 'Rename conversation' },
						});
						setIcon(renameBtn, 'pencil');
						setTooltip(renameBtn, 'Rename');
						renameBtn.addEventListener('click', (e) => {
							e.stopPropagation();
							this.confirmDeleteSessionId = null;
							this.editingSessionId = sessionId;
							this.renderList();
						});
					}
					if (canDelete) {
						const deleteBtn = actions.createEl('button', {
							cls: 'antidian-session-action-btn is-danger-hover',
							attr: { type: 'button', 'aria-label': 'Delete conversation' },
						});
						setIcon(deleteBtn, 'trash-2');
						setTooltip(deleteBtn, 'Delete');
						deleteBtn.addEventListener('click', (e) => {
							e.stopPropagation();
							this.editingSessionId = null;
							this.confirmDeleteSessionId = sessionId;
							this.renderList();
						});
					}
				}
			}

			if (canPin || canRename || canDelete) {
				row.addEventListener('contextmenu', (e) => {
					e.preventDefault();
					e.stopPropagation();
					const menu = new Menu();
					if (canPin) {
						menu.addItem((item) =>
							item
								.setTitle(opts.isPinned ? 'Unpin' : 'Pin')
								.setIcon(opts.isPinned ? 'pin-off' : 'pin')
								.onClick(togglePin),
						);
					}
					if (canRename) {
						menu.addItem((item) =>
							item
								.setTitle('Rename')
								.setIcon('pencil')
								.onClick(() => {
									this.confirmDeleteSessionId = null;
									this.editingSessionId = sessionId;
									this.renderList();
								}),
						);
					}
					if (canDelete) {
						menu.addItem((item) =>
							item
								.setTitle('Delete')
								.setIcon('trash-2')
								.onClick(() => {
									this.editingSessionId = null;
									this.confirmDeleteSessionId = sessionId;
									this.renderList();
								}),
						);
					}
					menu.showAtMouseEvent(e);
				});
			}
		}

		this.bindItem({ kind: 'session', el: row, session: opts.session });
	}

	private getPinnedIds(): string[] {
		return [...(this.options.getPinnedSessions?.() ?? [])];
	}

	private setPinnedIds(ids: string[]): void {
		this.options.setPinnedSessions?.(ids);
	}

	private renderHighlighted(el: HTMLElement, text: string, ranges: MatchRange[]): void {
		let pos = 0;
		for (const [start, end] of ranges) {
			if (start > pos) el.appendText(text.slice(pos, start));
			el.createSpan({ cls: 'antidian-session-match', text: text.slice(start, end) });
			pos = end;
		}
		if (pos < text.length) el.appendText(text.slice(pos));
	}

	private renderStatus(list: HTMLElement, text: string, spinner = false): void {
		const el = list.createDiv({ cls: 'antidian-session-status', text });
		if (spinner) el.addClass('is-loading');
	}

	private bindItem(item: DrawerItem): void {
		this.items.push(item);
		item.el.addEventListener('mousemove', () => {
			const index = this.items.indexOf(item);
			if (index !== -1 && this.activeIndex !== index) {
				this.activeIndex = index;
				this.highlight();
			}
		});
		item.el.addEventListener('click', (e) => {
			e.stopPropagation();
			this.choose(item);
		});
	}

	private highlight(): void {
		this.items.forEach((item, i) => {
			item.el.toggleClass('is-highlighted', i === this.activeIndex);
		});
		// Session rows get the sliding highlight; "New Conversation" keeps its own style.
		const active = this.items[this.activeIndex];
		this.glider?.moveTo(active?.kind === 'session' ? active.el : null);
	}

	private choose(item: DrawerItem): void {
		if (
			item.kind === 'session' &&
			(this.editingSessionId === item.session.sessionId ||
				this.confirmDeleteSessionId === item.session.sessionId)
		) {
			return;
		}
		this.close();
		if (item.kind === 'new') this.options.onNewSession();
		else this.options.onSelectSession(item.session);
	}

	private onKeyDown(e: KeyboardEvent): void {
		if (this.editingSessionId) return;
		if (e.key === 'Escape' && this.confirmDeleteSessionId) {
			e.preventDefault();
			e.stopPropagation();
			this.confirmDeleteSessionId = null;
			this.renderList();
			return;
		}
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			if (this.items.length === 0) return;
			const delta = e.key === 'ArrowDown' ? 1 : -1;
			const start = this.activeIndex === -1 && delta < 0 ? 0 : this.activeIndex;
			this.activeIndex = (start + delta + this.items.length) % this.items.length;
			this.highlight();
			this.items[this.activeIndex]?.el.scrollIntoView({ block: 'nearest' });
		} else if (e.key === 'Enter') {
			const item = this.items[this.activeIndex];
			if (item) {
				e.preventDefault();
				this.choose(item);
			}
		} else if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			const trigger = this.triggerEl;
			this.close();
			trigger?.focus();
		}
	}
}
