import { App, setIcon, setTooltip } from 'obsidian';
import { bindNoteLink } from './note-link';
import { ContextReference } from '../../core/types/context';

export interface GroupedContextChunk {
	id: string;
	title: string;
	path: string;
	headings: string[];
	reason: string;
	snippet?: string;
	chars?: number;
	badge: string;
	isUrl: boolean;
}

export class ContextCardsView {
	private app: App;
	private parentEl: HTMLElement;
	private containerEl: HTMLElement;
	private isExpanded = false;

	constructor(parentEl: HTMLElement, app: App, contextUsed: ContextReference[]) {
		this.parentEl = parentEl;
		this.app = app;
		this.containerEl = this.parentEl.createDiv({
			cls: 'anti-dian-context-cards-container',
		});
		this.render(contextUsed);
	}

	private getBadgeForPath(path: string): string {
		if (/^https?:\/\//i.test(path)) return 'WEB';
		const ext = path.split('.').pop()?.toUpperCase();
		if (ext === 'MD') return 'MD';
		if (ext === 'PDF') return 'PDF';
		if (ext === 'CSV') return 'CSV';
		if (ext === 'JSON') return 'JSON';
		return ext || 'FILE';
	}

	private groupContext(contextUsed: ContextReference[]): GroupedContextChunk[] {
		const map = new Map<string, GroupedContextChunk>();

		for (const ref of contextUsed) {
			const existing = map.get(ref.path);
			if (existing) {
				if (ref.heading && !existing.headings.includes(ref.heading)) {
					existing.headings.push(ref.heading);
				}
				if (ref.snippet && !existing.snippet) {
					existing.snippet = ref.snippet;
				}
			} else {
				const isUrl = /^https?:\/\//i.test(ref.path);
				const noteName = isUrl
					? ref.path.replace(/^https?:\/\//, '').split('/')[0] || ref.path
					: ref.path.replace(/\.md$/, '').split('/').pop() || ref.path;

				map.set(ref.path, {
					id: `ctx_${map.size + 1}`,
					title: ref.heading ? `${noteName} > #${ref.heading}` : noteName,
					path: ref.path,
					headings: ref.heading ? [ref.heading] : [],
					reason: ref.reason,
					snippet: ref.snippet,
					chars: ref.chars,
					badge: this.getBadgeForPath(ref.path),
					isUrl,
				});
			}
		}

		return Array.from(map.values());
	}

	private render(contextUsed: ContextReference[]): void {
		const chunks = this.groupContext(contextUsed);
		if (chunks.length === 0) return;

		// Header Row
		const headerBtn = this.containerEl.createEl('button', {
			cls: 'anti-dian-context-cards-header-btn',
			attr: {
				type: 'button',
				'aria-expanded': 'false',
			},
		});

		const titleSpan = headerBtn.createSpan({
			cls: 'anti-dian-context-cards-title',
			text: 'Context used',
		});
		titleSpan.addClass('anti-dian-context-title-label');

		const countBadge = headerBtn.createSpan({
			cls: 'anti-dian-context-count-badge',
			text: String(chunks.length),
		});
		setTooltip(countBadge, `${chunks.length} sources used`);

		const chevron = headerBtn.createSpan({
			cls: 'anti-dian-context-chevron collapse-icon is-collapsed',
		});
		setIcon(chevron, 'right-triangle');

		// Cards Grid Wrapper
		const gridWrapper = this.containerEl.createDiv({
			cls: 'anti-dian-context-cards-grid',
		});

		headerBtn.onclick = (e) => {
			e.stopPropagation();
			this.isExpanded = !this.isExpanded;
			headerBtn.setAttribute('aria-expanded', String(this.isExpanded));
			chevron.toggleClass('is-collapsed', !this.isExpanded);
			gridWrapper.toggleClass('is-open', this.isExpanded);
		};

		// Render Each Context Card
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			if (!chunk) continue;

			const card = gridWrapper.createDiv({
				cls: 'anti-dian-context-card',
			});

			// Top Card Bar
			const cardBar = card.createDiv({
				cls: 'anti-dian-context-card-bar',
			});

			const leftInfo = cardBar.createSpan({
				cls: 'anti-dian-context-card-left',
			});

			const iconSpan = leftInfo.createSpan({
				cls: 'anti-dian-context-card-icon',
			});
			setIcon(iconSpan, chunk.isUrl ? 'globe' : 'file-text');

			leftInfo.createSpan({
				cls: 'anti-dian-context-card-title',
				text: chunk.title,
			});

			const rightReason = cardBar.createSpan({
				cls: 'anti-dian-context-card-meta',
				text: chunk.chars ? `${chunk.chars.toLocaleString()} chars` : chunk.reason,
			});
			rightReason.addClass('anti-dian-context-card-chars');

			// Card Body Snippet / Headings
			if (chunk.snippet) {
				const body = card.createEl('p', {
					cls: 'anti-dian-context-card-body',
					text: chunk.snippet,
				});
				setTooltip(body, chunk.snippet, { placement: 'top' });
			} else if (chunk.headings.length > 0) {
				const headingsEl = card.createDiv({
					cls: 'anti-dian-context-card-headings',
				});
				for (const h of chunk.headings) {
					headingsEl.createDiv({
						cls: 'anti-dian-context-card-heading-tag',
						text: `Section: #${h}`,
					});
				}
			}

			// Bottom Source Chip (clickable)
			const chipRow = card.createDiv({
				cls: 'anti-dian-context-card-chip-row',
			});

			const chip = chipRow.createEl(chunk.isUrl ? 'a' : 'button', {
				cls: 'anti-dian-context-card-chip',
				attr: chunk.isUrl
					? {
							href: chunk.path,
							target: '_blank',
							rel: 'noopener noreferrer',
						}
					: { type: 'button' },
			});

			chip.createSpan({
				cls: `anti-dian-context-badge badge-${chunk.badge.toLowerCase()}`,
				text: chunk.badge,
			});

			const sourceName = chunk.path.replace(/^https?:\/\//, '').split('/').pop() || chunk.path;
			chip.createSpan({
				cls: 'anti-dian-context-chip-name',
				text: sourceName,
			});

			const arrowIcon = chip.createSpan({
				cls: 'anti-dian-context-chip-arrow',
			});
			setIcon(arrowIcon, 'arrow-up-right');

			if (!chunk.isUrl) {
				bindNoteLink(this.app, chip, { path: chunk.path });
			}
		}
	}
}
