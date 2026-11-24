import { App, HoverParent, HoverPopover, Keymap } from 'obsidian';

/** Hover source id registered in main.ts via `registerHoverLinkSource`. */
export const ANTI_DIAN_HOVER_SOURCE = 'anti-dian';

/** Shared hover parent for views that are not themselves a `HoverParent`. */
const sharedHoverParent: HoverParent = { hoverPopover: null as HoverPopover | null };

export interface NoteLinkOptions {
	/** Path or link text of the vault note to open. */
	path: string;
	/** Source note for resolving relative link text. Defaults to the vault root. */
	sourcePath?: string;
	hoverParent?: HoverParent;
	/**
	 * When set, a plain click calls this instead of opening the note; a
	 * Ctrl/Cmd-click still opens it. Used where a click already means something.
	 */
	onPlainClick?: (evt: MouseEvent) => void;
}

/**
 * Turn `el` into a native-feeling internal link: Page Preview on hover
 * (Ctrl/Cmd + hover by default), click to open, Ctrl/Cmd-click or middle-click
 * to open in a new tab.
 */
export function bindNoteLink(app: App, el: HTMLElement, opts: NoteLinkOptions): void {
	const sourcePath = opts.sourcePath ?? '';
	el.addClass('internal-link');
	el.setAttribute('data-href', opts.path);

	el.addEventListener('mouseover', (event: MouseEvent) => {
		app.workspace.trigger('hover-link', {
			event,
			source: ANTI_DIAN_HOVER_SOURCE,
			hoverParent: opts.hoverParent ?? sharedHoverParent,
			targetEl: el,
			linktext: opts.path,
			sourcePath,
		});
	});

	el.addEventListener('click', (evt: MouseEvent) => {
		evt.preventDefault();
		evt.stopPropagation();
		const newLeaf = Keymap.isModEvent(evt);
		if (!newLeaf && opts.onPlainClick) {
			opts.onPlainClick(evt);
			return;
		}
		void app.workspace.openLinkText(opts.path, sourcePath, newLeaf);
	});

	el.addEventListener('auxclick', (evt: MouseEvent) => {
		if (evt.button !== 1) return;
		evt.preventDefault();
		evt.stopPropagation();
		void app.workspace.openLinkText(opts.path, sourcePath, 'tab');
	});
}
