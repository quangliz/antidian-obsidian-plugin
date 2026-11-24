/**
 * Pure helpers for showing a sent user message (no Obsidian imports, so they are unit-testable).
 *
 * The prompt bar sends each attached selection as a quoted block ahead of the
 * typed text (see `PromptBarView.formatSelectionBlock`):
 *
 *     From [[note]] (L12-14):
 *     > selected line
 *     > selected line
 *
 * (or `Selected text (L3):` when the note is unknown). The bubble shows those
 * blocks as chips again instead of the raw quote.
 */

export interface SentSelection {
	/** Note name without `.md`, when the selection came from a note. */
	note?: string;
	startLine?: number;
	endLine?: number;
	/** The selected text, unquoted. */
	text: string;
}

export interface ParsedUserMessage {
	selections: SentSelection[];
	/** What the user typed, after the selection blocks. */
	body: string;
}

const HEADER_RE = /^(?:From \[\[([^\]\n]+)\]\]|Selected text)(?: \(L(\d+)(?:-(\d+))?\))?:$/;

/** Splits leading selection blocks off a sent message; other text is left as is. */
export function parseUserMessage(text: string): ParsedUserMessage {
	const lines = text.split('\n');
	const selections: SentSelection[] = [];
	let i = 0;
	while (i < lines.length) {
		const header = HEADER_RE.exec(lines[i] ?? '');
		if (!header) break;
		const quoted: string[] = [];
		let j = i + 1;
		while (j < lines.length && /^>( |$)/.test(lines[j] ?? '')) {
			quoted.push((lines[j] ?? '').replace(/^> ?/, ''));
			j++;
		}
		// A header with no quote under it is ordinary text.
		if (quoted.length === 0) break;
		const startLine = header[2] !== undefined ? Number(header[2]) : undefined;
		selections.push({
			...(header[1] !== undefined ? { note: header[1] } : {}),
			...(startLine !== undefined ? { startLine } : {}),
			...(header[3] !== undefined ? { endLine: Number(header[3]) } : {}),
			text: quoted.join('\n'),
		});
		i = j;
		// Blocks are joined by a blank line.
		while (i < lines.length && lines[i] === '') i++;
	}
	if (selections.length === 0) return { selections, body: text };
	return { selections, body: lines.slice(i).join('\n') };
}

/** Chip label, matching the prompt bar's tray: `note:12-14`. */
export function selectionChipLabel(selection: SentSelection): string {
	const name = selection.note ?? 'Selection';
	if (selection.startLine === undefined) return name;
	const range =
		selection.endLine !== undefined && selection.endLine !== selection.startLine
			? `${selection.startLine}-${selection.endLine}`
			: `${selection.startLine}`;
	return `${name}:${range}`;
}
