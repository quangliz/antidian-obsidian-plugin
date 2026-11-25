import type { Menu } from 'obsidian';

/** `Menu.dom` exists at runtime but is not in the public typings. */
type MenuWithDom = Menu & { dom?: HTMLElement };

/**
 * Sliding highlight behind the hovered / keyboard-selected row of a menu,
 * the same animation as the `@` and `/` autocomplete menu.
 *
 * The glider is an absolutely positioned child of `container`, so rows must
 * sit above it (`.anti-dian-glide-host` styles handle that).
 */
export class MenuGlider {
	private el: HTMLElement;
	private current: HTMLElement | null = null;

	constructor(private container: HTMLElement) {
		container.addClass('anti-dian-glide-host');
		this.el = container.createSpan({ cls: 'anti-dian-glider', attr: { 'aria-hidden': 'true' } });
	}

	/** Slide to `row`; jumps without animation when coming from hidden. */
	moveTo(row: HTMLElement | null): void {
		if (!row || !this.container.contains(row)) {
			this.hide();
			return;
		}
		const wasHidden = this.current === null;
		this.current = row;
		const box = this.container.getBoundingClientRect();
		const rect = row.getBoundingClientRect();
		this.el.toggleClass('is-instant', wasHidden);
		this.el.setCssProps({
			top: `${rect.top - box.top - this.container.clientTop + this.container.scrollTop}px`,
			left: `${rect.left - box.left - this.container.clientLeft + this.container.scrollLeft}px`,
			width: `${rect.width}px`,
			height: `${rect.height}px`,
		});
		this.el.addClass('is-visible');
		if (wasHidden) {
			// Re-enable the transition after the instant jump has been painted.
			void this.el.offsetWidth;
			this.el.removeClass('is-instant');
		}
	}

	get element(): HTMLElement {
		return this.el;
	}

	hide(): void {
		this.current = null;
		this.el.removeClass('is-visible');
	}

	/** Follow pointer hover over rows matching `rowSelector`; hide when leaving. */
	trackHover(rowSelector: string): void {
		this.container.addEventListener('mouseover', (evt) => {
			const row = (evt.target as HTMLElement | null)?.closest<HTMLElement>(rowSelector);
			if (row && this.container.contains(row) && !row.matches(':disabled')) this.moveTo(row);
		});
		this.container.addEventListener('mouseleave', () => this.hide());
	}
}

/**
 * Adds the glider to a native Obsidian `Menu` (and its submenus, if attached
 * separately): it follows whichever `.menu-item` Obsidian marks `.selected`,
 * which covers both mouse hover and arrow-key navigation.
 */
export function attachNativeMenuGlider(menu: Menu): void {
	const dom = (menu as MenuWithDom).dom;
	if (!dom) return;
	dom.addClass('anti-dian-glide-menu');
	const glider = new MenuGlider(dom);
	// Obsidian also marks label rows ("Model", "Permission") as selected; skip them.
	// The effort bar shows its own selected state.
	const sync = () =>
		glider.moveTo(
			dom.querySelector<HTMLElement>(
				'.menu-item.selected:not(.is-label, .is-disabled, :has(.anti-dian-effort))',
			),
		);
	// Ignore the glider's own class changes, or syncing would retrigger itself.
	new MutationObserver((records) => {
		if (records.some((r) => r.target !== glider.element)) sync();
	}).observe(dom, {
		subtree: true,
		attributes: true,
		attributeFilter: ['class'],
	});
	// Rows move when a section above them opens or collapses.
	new ResizeObserver(sync).observe(dom);
}
