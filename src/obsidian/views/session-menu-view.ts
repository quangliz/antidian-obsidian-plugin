import { setIcon } from 'obsidian';
import type { AcpSessionSummary } from '../../core/models/antigravity-acp';
import {
	UNTITLED_SESSION,
	filterSessions,
	formatRelativeTime,
	groupSessionsByRecency,
} from './session-format';

export interface SessionMenuOptions {
	/** Shown above the list so the user knows which vault's sessions these are. */
	getVaultName: () => string;
	listSessions: () => Promise<AcpSessionSummary[]>;
	getCurrentSessionId: () => string | null;
	onSelectSession: (session: AcpSessionSummary) => void;
	onNewSession: () => void;
}

type MenuItem =
	| { kind: 'new'; el: HTMLElement }
	| { kind: 'session'; el: HTMLElement; session: AcpSessionSummary };

/**
 * Session picker dropdown anchored under the sidebar's top nav: search,
 * "New chat", and this vault's stored sessions grouped by recency.
 */
export class SessionMenuController {
	private popupEl: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private searchEl: HTMLInputElement | null = null;
	private items: MenuItem[] = [];
	private activeIndex = 0;
	private sessions: AcpSessionSummary[] | null = null;
	private loading = false;
	private error: string | null = null;
	private loadToken = 0;
	private triggerEl: HTMLElement | null = null;

	constructor(
		private hostEl: HTMLElement,
		private options: SessionMenuOptions,
	) {}

	isOpen(): boolean {
		return this.popupEl !== null;
	}

	toggle(triggerEl: HTMLElement): void {
		if (this.isOpen()) this.close();
		else this.open(triggerEl);
	}

	open(triggerEl: HTMLElement): void {
		this.close();
		this.triggerEl = triggerEl;
		triggerEl.setAttribute('aria-expanded', 'true');
		triggerEl.addClass('is-active');

		const popup = this.hostEl.createDiv({
			cls: 'anti-dian-session-menu',
			attr: { role: 'dialog', 'aria-label': 'Sessions' },
		});
		this.popupEl = popup;

		const header = popup.createDiv({ cls: 'anti-dian-session-menu-header' });
		const headerIcon = header.createSpan({
			cls: 'anti-dian-session-menu-header-icon',
		});
		setIcon(headerIcon, 'folder');
		header.createSpan({
			cls: 'anti-dian-session-menu-header-title',
			text: this.options.getVaultName(),
		});

		const searchWrap = popup.createDiv({
			cls: 'anti-dian-session-search',
		});
		const searchIcon = searchWrap.createSpan({
			cls: 'anti-dian-session-search-icon',
		});
		setIcon(searchIcon, 'search');
		this.searchEl = searchWrap.createEl('input', {
			type: 'text',
			cls: 'anti-dian-session-search-input',
			attr: { placeholder: 'Search sessions', spellcheck: 'false' },
		});
		this.searchEl.addEventListener('input', () => {
			this.activeIndex = 0;
			this.renderList();
		});
		this.searchEl.addEventListener('keydown', (e) => this.onKeyDown(e));

		this.listEl = popup.createDiv({
			cls: 'anti-dian-session-list',
			attr: { role: 'listbox' },
		});

		this.activeIndex = 0;
		this.renderList();
		window.setTimeout(() => this.searchEl?.focus(), 0);
		void this.refresh();
	}

	close(): void {
		this.loadToken++;
		this.popupEl?.remove();
		this.popupEl = null;
		this.listEl = null;
		this.searchEl = null;
		this.items = [];
		if (this.triggerEl) {
			this.triggerEl.setAttribute('aria-expanded', 'false');
			this.triggerEl.removeClass('is-active');
			this.triggerEl = null;
		}
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
		this.items = [];

		const newRow = list.createDiv({
			cls: 'anti-dian-session-item anti-dian-session-item-new',
			attr: { role: 'option' },
		});
		const newIcon = newRow.createSpan({ cls: 'anti-dian-session-item-icon' });
		setIcon(newIcon, 'plus');
		newRow.createSpan({
			cls: 'anti-dian-session-item-title',
			text: 'New chat',
		});
		this.bindItem({ kind: 'new', el: newRow });

		const query = this.searchEl?.value ?? '';
		const all = this.sessions ?? [];
		const filtered = filterSessions(all, query);
		const currentId = this.options.getCurrentSessionId();

		if (this.sessions === null && this.loading) {
			this.renderStatus(list, 'Loading sessions…', true);
		} else if (this.error && all.length === 0) {
			this.renderStatus(list, `Couldn't load sessions: ${this.error}`);
		} else if (all.length === 0) {
			this.renderStatus(list, 'No previous sessions in this vault yet.');
		} else if (filtered.length === 0) {
			this.renderStatus(list, 'No sessions match your search.');
		}

		for (const group of groupSessionsByRecency(filtered)) {
			list.createDiv({
				cls: 'anti-dian-session-group-label',
				text: group.label,
			});
			for (const session of group.sessions) {
				const isCurrent = session.sessionId === currentId;
				const row = list.createDiv({
					cls: 'anti-dian-session-item',
					attr: {
						role: 'option',
						'aria-selected': String(isCurrent),
					},
				});
				if (isCurrent) row.addClass('is-current');
				const icon = row.createSpan({ cls: 'anti-dian-session-item-icon' });
				setIcon(icon, isCurrent ? 'message-square-dot' : 'message-square');
				const title = session.title ?? UNTITLED_SESSION;
				row.createSpan({
					cls: 'anti-dian-session-item-title',
					text: title,
					attr: { title },
				});
				row.createSpan({
					cls: 'anti-dian-session-item-time',
					text: formatRelativeTime(session.updatedAt),
				});
				this.bindItem({ kind: 'session', el: row, session });
			}
		}

		if (this.loading && this.sessions !== null) {
			list.addClass('is-refreshing');
		} else {
			list.removeClass('is-refreshing');
		}

		this.activeIndex = Math.min(this.activeIndex, this.items.length - 1);
		// Prefer the first matching session while searching.
		if (query.trim() && this.activeIndex === 0 && this.items.length > 1) {
			this.activeIndex = 1;
		}
		this.highlight();
	}

	private renderStatus(list: HTMLElement, text: string, spinner = false): void {
		const el = list.createDiv({ cls: 'anti-dian-session-status', text });
		if (spinner) el.addClass('is-loading');
	}

	private bindItem(item: MenuItem): void {
		const index = this.items.length;
		this.items.push(item);
		item.el.addEventListener('mousemove', () => {
			if (this.activeIndex !== index) {
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
	}

	private choose(item: MenuItem): void {
		this.close();
		if (item.kind === 'new') this.options.onNewSession();
		else this.options.onSelectSession(item.session);
	}

	private onKeyDown(e: KeyboardEvent): void {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			if (this.items.length === 0) return;
			const delta = e.key === 'ArrowDown' ? 1 : -1;
			this.activeIndex =
				(this.activeIndex + delta + this.items.length) % this.items.length;
			this.highlight();
			this.items[this.activeIndex]?.el.scrollIntoView({ block: 'nearest' });
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const item = this.items[this.activeIndex];
			if (item) this.choose(item);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			const trigger = this.triggerEl;
			this.close();
			trigger?.focus();
		}
	}
}
