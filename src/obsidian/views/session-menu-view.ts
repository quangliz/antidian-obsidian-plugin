import { setIcon } from 'obsidian';
import type { AcpSessionSummary } from '../../core/models/antigravity-acp';
import {
	MatchRange,
	UNTITLED_SESSION,
	formatRelativeTime,
	searchSessions,
} from './session-format';
import { MenuGlider } from './menu-glider';

export interface SessionMenuOptions {
	/** Heading of the session list: this vault's sessions. */
	getVaultName: () => string;
	listSessions: () => Promise<AcpSessionSummary[]>;
	getCurrentSessionId: () => string | null;
	onSelectSession: (session: AcpSessionSummary) => void;
	onNewSession: () => void;
}

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

		const root = this.hostEl.createDiv({ cls: 'anti-dian-session-drawer' });
		this.rootEl = root;
		const backdrop = root.createDiv({ cls: 'anti-dian-session-drawer-backdrop' });
		backdrop.addEventListener('click', () => this.close());

		const panel = root.createDiv({
			cls: 'anti-dian-session-drawer-panel',
			attr: { role: 'dialog', 'aria-label': 'Conversations' },
		});
		panel.addEventListener('keydown', (e) => this.onKeyDown(e));

		const closeBtn = panel.createEl('button', {
			cls: 'anti-dian-session-drawer-close',
			attr: { 'aria-label': 'Close' },
		});
		setIcon(closeBtn, 'x');
		closeBtn.addEventListener('click', () => this.close());

		const newBtn = panel.createDiv({
			cls: 'anti-dian-session-new',
			attr: { role: 'button', tabindex: '-1' },
		});
		const newIcon = newBtn.createSpan({ cls: 'anti-dian-session-new-icon' });
		setIcon(newIcon, 'plus');
		newBtn.createSpan({ text: 'New Conversation' });
		this.items = [];
		this.bindItem({ kind: 'new', el: newBtn });

		this.searchWrapEl = panel.createDiv({ cls: 'anti-dian-session-search' });
		const searchIcon = this.searchWrapEl.createSpan({
			cls: 'anti-dian-session-search-icon',
		});
		setIcon(searchIcon, 'search');
		this.searchEl = this.searchWrapEl.createEl('input', {
			type: 'text',
			cls: 'anti-dian-session-search-input',
			attr: { placeholder: 'Search conversations', spellcheck: 'false' },
		});
		this.searchEl.addEventListener('input', () => {
			this.activeIndex = -1;
			this.renderList();
		});
		this.searchWrapEl.toggleClass('anti-dian-hidden', !opts.search);

		panel.createDiv({ cls: 'anti-dian-session-section-label', text: 'Conversations' });

		this.listEl = panel.createDiv({
			cls: 'anti-dian-session-list',
			attr: { role: 'listbox' },
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
		if (this.triggerEl) {
			this.triggerEl.setAttribute('aria-expanded', 'false');
			this.triggerEl.removeClass('is-active');
			this.triggerEl = null;
		}
	}

	/** Slide the panel back out and fade the backdrop, then remove the drawer. */
	private animateOut(root: HTMLElement): void {
		root.addClass('is-closing');
		const panel = root.querySelector('.anti-dian-session-drawer-panel');
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

		const folder = list.createDiv({ cls: 'anti-dian-session-folder' });
		const folderIcon = folder.createSpan({ cls: 'anti-dian-session-folder-icon' });
		setIcon(folderIcon, 'folder-open');
		folder.createSpan({
			cls: 'anti-dian-session-folder-name',
			text: this.options.getVaultName(),
		});

		const query = this.searchEl?.value.trim() ?? '';
		const all = this.sessions ?? [];
		const hits = searchSessions(all, query);
		const currentId = this.options.getCurrentSessionId();

		if (this.sessions === null && this.loading) {
			this.renderStatus(list, 'Loading…', true);
		} else if (this.error && all.length === 0) {
			this.renderStatus(list, `Couldn't load conversations: ${this.error}`);
		} else if (all.length === 0) {
			this.renderStatus(list, 'No conversations yet');
		} else if (hits.length === 0) {
			this.renderStatus(list, 'No matching conversations');
		}

		const collapsed = !this.showAll && !query && hits.length > COLLAPSED_SESSION_COUNT;
		const visible = collapsed ? hits.slice(0, COLLAPSED_SESSION_COUNT) : hits;

		for (const { session, ranges } of visible) {
			const isCurrent = session.sessionId === currentId;
			const row = list.createDiv({
				cls: 'anti-dian-session-item',
				attr: { role: 'option', 'aria-selected': String(isCurrent) },
			});
			if (isCurrent) row.addClass('is-current');
			const title = session.title ?? UNTITLED_SESSION;
			const titleEl = row.createSpan({
				cls: 'anti-dian-session-item-title',
				attr: { title },
			});
			this.renderHighlighted(titleEl, title, ranges);
			row.createSpan({
				cls: 'anti-dian-session-item-time',
				text: formatRelativeTime(session.updatedAt),
			});
			this.bindItem({ kind: 'session', el: row, session });
		}

		if (collapsed) {
			const seeAll = list.createDiv({
				cls: 'anti-dian-session-see-all',
				text: `See all (${hits.length})`,
				attr: { role: 'button' },
			});
			seeAll.addEventListener('mouseenter', () => this.glider?.moveTo(seeAll));
			seeAll.addEventListener('mouseleave', () => this.glider?.hide());
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

	private renderHighlighted(el: HTMLElement, text: string, ranges: MatchRange[]): void {
		let pos = 0;
		for (const [start, end] of ranges) {
			if (start > pos) el.appendText(text.slice(pos, start));
			el.createSpan({ cls: 'anti-dian-session-match', text: text.slice(start, end) });
			pos = end;
		}
		if (pos < text.length) el.appendText(text.slice(pos));
	}

	private renderStatus(list: HTMLElement, text: string, spinner = false): void {
		const el = list.createDiv({ cls: 'anti-dian-session-status', text });
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
		item.el.addEventListener('mouseleave', () => {
			if (this.items[this.activeIndex] === item) {
				this.activeIndex = -1;
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
		this.close();
		if (item.kind === 'new') this.options.onNewSession();
		else this.options.onSelectSession(item.session);
	}

	private onKeyDown(e: KeyboardEvent): void {
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
