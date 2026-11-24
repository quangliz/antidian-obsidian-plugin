import {
	App,
	Component,
	HoverParent,
	HoverPopover,
	Keymap,
	Notice,
	PaneType,
} from 'obsidian';

/** Hover source id registered in main.ts via `registerHoverLinkSource`. */
export const ANTI_DIAN_HOVER_SOURCE = 'anti-dian';

const BOUND_ATTR = 'data-anti-dian-link';

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
	// Has its own handlers; the delegated handler below must skip it.
	el.setAttribute(BOUND_ATTR, '');

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

/** A whole inline-code span that is just a wikilink, e.g. `[[Note|alias]]`. */
const CODE_WIKILINK = /^\[\[([^[\]|#^]+)(#[^[\]|]*)?(?:\|([^[\]]+))?\]\]$/;

/**
 * Models often wrap wikilinks in backticks, which Markdown renders as code.
 * Turn such spans into real internal links when the note exists; code blocks
 * and code that isn't a lone wikilink are left alone.
 */
export function linkifyCodeWikilinks(app: App, el: HTMLElement, sourcePath: string): void {
	for (const code of Array.from(el.querySelectorAll('code'))) {
		if (code.closest('pre')) continue;
		const match = CODE_WIKILINK.exec(code.textContent?.trim() ?? '');
		if (!match?.[1]) continue;
		const target = match[1].trim();
		const subpath = match[2] ?? '';
		if (!app.metadataCache.getFirstLinkpathDest(target, sourcePath)) continue;
		const link = createEl('a', {
			cls: 'internal-link',
			text: match[3]?.trim() || `${target}${subpath}`,
			attr: { 'data-href': `${target}${subpath}`, href: `${target}${subpath}` },
		});
		code.replaceWith(link);
	}
}

/**
 * Make internal links inside rendered Markdown (answers, thoughts) behave as in
 * a note: click / mod-click to open, hover preview. Links to notes that don't
 * exist only show a notice — following them would silently create a file.
 */
export function registerInternalLinkHandlers(
	component: Component,
	app: App,
	containerEl: HTMLElement,
	getSourcePath: () => string,
	hoverParent?: HoverParent,
): void {
	const linkFrom = (evt: MouseEvent): HTMLElement | null => {
		const target = evt.target;
		if (!(target instanceof HTMLElement)) return null;
		const link = target.closest<HTMLElement>('a.internal-link');
		if (!link || link.hasAttribute(BOUND_ATTR) || !containerEl.contains(link)) return null;
		return link;
	};
	const linktext = (link: HTMLElement) =>
		link.getAttribute('data-href') ?? link.getAttribute('href') ?? '';

	const open = (evt: MouseEvent, newLeaf: boolean | PaneType) => {
		const link = linkFrom(evt);
		if (!link) return;
		evt.preventDefault();
		evt.stopPropagation();
		const text = linktext(link);
		const sourcePath = getSourcePath();
		const path = text.split('#')[0] ?? text;
		if (!app.metadataCache.getFirstLinkpathDest(path, sourcePath)) {
			new Notice(`Note "${path}" not found`);
			return;
		}
		void app.workspace.openLinkText(text, sourcePath, newLeaf);
	};

	component.registerDomEvent(containerEl, 'click', (evt) => open(evt, Keymap.isModEvent(evt)));
	component.registerDomEvent(containerEl, 'auxclick', (evt) => {
		if (evt.button === 1) open(evt, 'tab');
	});
	component.registerDomEvent(containerEl, 'mouseover', (event) => {
		const link = linkFrom(event);
		if (!link) return;
		app.workspace.trigger('hover-link', {
			event,
			source: ANTI_DIAN_HOVER_SOURCE,
			hoverParent: hoverParent ?? sharedHoverParent,
			targetEl: link,
			linktext: linktext(link),
			sourcePath: getSourcePath(),
		});
	});
}
