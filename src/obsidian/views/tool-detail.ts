import { App, HoverParent } from 'obsidian';
import { FileDiff } from '../../core/types/changes';
import { renderFileDiff } from './diff-lines';
import { bindNoteLink } from './note-link';
import { originalTextSize } from '../../core/sessions/trace';

/** What the detail renderer needs to know about one tool call. */
export interface ToolDetailInput {
	toolName: string;
	status: 'running' | 'done' | 'error';
	args?: Record<string, unknown>;
	output?: unknown;
	error?: string;
	/** The staged change's diff, attached once the turn's ChangeSet is diffed. */
	fileDiff?: FileDiff;
	/** Search tools already list their sources under the row. */
	sourceCount: number;
}

export interface ToolDetailOptions {
	app: App;
	hoverParent?: HoverParent;
	showRaw: boolean;
}

type Renderer = (el: HTMLElement) => void;

const PREVIEW_CHARS = 160;
const MAX_LIST_ITEMS = 8;
const RAW_MAX_CHARS = 4000;

const MUTATING_TOOLS = new Set([
	'create_note',
	'edit_note',
	'patch_note',
	'replace_block',
	'append_note',
	'update_frontmatter',
]);

/* ------------------------------------------------------------------ */
/* Untrusted-data helpers: tool args and outputs are model/tool data. */
/* ------------------------------------------------------------------ */

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string | undefined =>
	typeof v === 'string' ? v : undefined;

const num = (v: unknown): number | undefined =>
	typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const truncate = (text: string, max: number): string =>
	text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;

const formatValue = (v: unknown): string => {
	if (typeof v === 'string') return v;
	try {
		return JSON.stringify(v) ?? String(v);
	} catch {
		return String(v);
	}
};

const lineCount = (text: string): number => text.split('\n').length;

const plural = (n: number, word: string): string =>
	`${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/* ------------------------------------------------------------------ */
/* Building blocks                                                     */
/* ------------------------------------------------------------------ */

function meta(el: HTMLElement, text: string): void {
	el.createDiv({ cls: 'anti-dian-tool-detail-meta', text });
}

function noteList(
	el: HTMLElement,
	paths: string[],
	opts: ToolDetailOptions,
	label = (p: string) => p.replace(/\.md$/, '').split('/').pop() || p,
): void {
	const list = el.createDiv({ cls: 'anti-dian-tool-detail-list' });
	for (const path of paths.slice(0, MAX_LIST_ITEMS)) {
		const item = list.createSpan({
			cls: 'anti-dian-tool-detail-note',
			text: label(path),
		});
		bindNoteLink(opts.app, item, { path, hoverParent: opts.hoverParent });
	}
	if (paths.length > MAX_LIST_ITEMS) {
		list.createSpan({
			cls: 'anti-dian-tool-detail-context',
			text: `+${paths.length - MAX_LIST_ITEMS} more`,
		});
	}
}

function rawData(el: HTMLElement, input: ToolDetailInput): void {
	const pre = el.createEl('pre', { cls: 'anti-dian-tool-detail-raw' });
	const payload: Record<string, unknown> = { args: input.args ?? {} };
	if (input.output !== undefined) payload.output = input.output;
	let text: string;
	try {
		text = JSON.stringify(payload, null, 2);
	} catch {
		text = '(tool data could not be serialized)';
	}
	pre.setText(truncate(text, RAW_MAX_CHARS));
}

/* ------------------------------------------------------------------ */
/* Per-tool summaries                                                  */
/* ------------------------------------------------------------------ */

/**
 * A staged edit shows its real diff (from the ChangeSet diff, attached when
 * the reply finishes); this is the one place changes are reviewed.
 */
function mutationDetail(input: ToolDetailInput): Renderer | null {
	const output = isRecord(input.output) ? input.output : undefined;
	if (output?.blockedByPlanMode) {
		return (el) => meta(el, 'Not staged: Plan mode is read-only.');
	}
	const fileDiff = input.fileDiff;
	if (!fileDiff) return null;
	return (el) => renderFileDiff(el, fileDiff);
}

/** Detail for read/list tools, from their output (only once finished). */
function resultDetail(input: ToolDetailInput, opts: ToolDetailOptions): Renderer | null {
	if (input.status !== 'done') return null;
	const output = input.output;
	// Replayed calls from before Anti-dian saved traces: the CLI kept no result.
	if (output === undefined) {
		return (el) => meta(el, 'Result was not saved for this earlier turn');
	}

	switch (input.toolName) {
		case 'read_note': {
			if (!isRecord(output)) return (el) => meta(el, 'Note not found');
			const content = str(output.content) ?? '';
			const heading = str(output.heading);
			// Saved traces cut long content; they keep its real size.
			const size = originalTextSize(output, 'content');
			const parts = [
				heading ? `#${heading}` : 'Whole note',
				plural(size?.chars ?? content.length, 'char'),
				plural(size?.lines ?? lineCount(content), 'line'),
			];
			if (output.isStaged) parts.push('includes staged edits');
			return (el) => meta(el, parts.join(' · '));
		}
		case 'get_note_outline': {
			if (!isRecord(output)) return (el) => meta(el, 'Note not found');
			const headings = Array.isArray(output.headings)
				? output.headings.filter(isRecord)
				: [];
			const tags = Array.isArray(output.tags) ? output.tags.length : 0;
			const links = Array.isArray(output.outgoingLinks) ? output.outgoingLinks.length : 0;
			const backlinks = Array.isArray(output.backlinks) ? output.backlinks.length : 0;
			return (el) => {
				meta(
					el,
					[
						plural(headings.length, 'heading'),
						plural(num(output.charCount) ?? 0, 'char'),
						plural(tags, 'tag'),
						plural(links, 'link'),
						plural(backlinks, 'backlink'),
					].join(' · '),
				);
				const list = el.createDiv({ cls: 'anti-dian-tool-detail-outline' });
				for (const h of headings.slice(0, 12)) {
					const level = Math.min(Math.max(num(h.level) ?? 1, 1), 6);
					const item = list.createDiv({
						cls: 'anti-dian-tool-detail-outline-item',
						text: str(h.heading) ?? '',
					});
					item.setCssProps({ '--anti-dian-outline-level': String(level - 1) });
				}
				if (headings.length > 12) {
					list.createDiv({
						cls: 'anti-dian-tool-detail-context',
						text: `+${headings.length - 12} more`,
					});
				}
			};
		}
		case 'list_notes': {
			const notes = Array.isArray(output)
				? output.filter(isRecord).map((n) => str(n.path)).filter((p): p is string => !!p)
				: [];
			return (el) => {
				meta(el, notes.length ? plural(notes.length, 'note') : 'No notes matched');
				if (notes.length) noteList(el, notes, opts);
			};
		}
		case 'search_notes':
		case 'web_search':
		case 'search_web':
			// Sources are listed under the row; only an empty result needs saying.
			return input.sourceCount === 0 ? (el) => meta(el, 'No results') : null;
		case 'list_skills': {
			const skills = Array.isArray(output) ? output.filter(isRecord) : [];
			return (el) => {
				if (!skills.length) {
					meta(el, 'No skills in .anti-dian/skills/');
					return;
				}
				for (const skill of skills.slice(0, MAX_LIST_ITEMS)) {
					const row = el.createDiv({ cls: 'anti-dian-tool-detail-skill' });
					row.createSpan({ cls: 'anti-dian-tool-detail-prop-key', text: str(skill.name) ?? '' });
					row.createSpan({
						cls: 'anti-dian-tool-detail-context',
						text: truncate(str(skill.description) ?? '', PREVIEW_CHARS),
					});
				}
			};
		}
		case 'load_skill': {
			if (!isRecord(output) || output.error) return null;
			const description = str(output.description);
			return description ? (el) => meta(el, truncate(description, PREVIEW_CHARS * 2)) : null;
		}
		default:
			return null;
	}
}

/** Unknown tools: the arguments are the best summary available. */
function fallbackDetail(input: ToolDetailInput): Renderer | null {
	const entries = Object.entries(input.args ?? {}).filter(([k]) => k !== 'path');
	if (entries.length === 0) return null;
	return (el) => {
		const box = el.createDiv({ cls: 'anti-dian-tool-detail-props' });
		for (const [key, value] of entries) {
			const row = box.createDiv({ cls: 'anti-dian-tool-detail-prop' });
			row.createSpan({ cls: 'anti-dian-tool-detail-prop-key', text: key });
			row.createSpan({ text: truncate(formatValue(value), PREVIEW_CHARS) });
		}
	};
}

const KNOWN_TOOLS = new Set([
	...MUTATING_TOOLS,
	'read_note',
	'get_note_outline',
	'list_notes',
	'search_notes',
	'web_search',
	'search_web',
	'list_skills',
	'load_skill',
]);

/**
 * Returns a renderer for the row's detail panel, or null when there is
 * nothing worth showing (the row then isn't expandable).
 */
export function buildToolDetail(
	input: ToolDetailInput,
	opts: ToolDetailOptions,
): Renderer | null {
	const isMutation = MUTATING_TOOLS.has(input.toolName);
	const summary = input.error
		? null
		: isMutation
			? mutationDetail(input)
			: KNOWN_TOOLS.has(input.toolName)
				? resultDetail(input, opts)
				: fallbackDetail(input);
	if (!input.error && !summary && !opts.showRaw) return null;

	return (el) => {
		if (input.error) {
			el.createDiv({ cls: 'anti-dian-tool-detail-error', text: input.error });
		}
		summary?.(el);
		if (opts.showRaw) rawData(el, input);
	};
}

