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

import type { PromptChip } from './prompt-chips';

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
	/** What the user typed, after the selection blocks (always a suffix of the text). */
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

export interface KnownChipLabels {
	/** `@` sources, without the `@` (e.g. "Web search"). */
	sources: string[];
	/** Slash commands, with the `/` (e.g. "/plan"). */
	commands: string[];
	/** Whether a note with this basename exists (for `@note`). */
	isNote: (name: string) => boolean;
}

/** Longest note name tried after `@` (names may contain spaces). */
const MAX_NOTE_NAME_LENGTH = 120;

/**
 * Chips for a message replayed from history, where the exact chip ranges were
 * not kept: `@source`, `/command` and `@note` labels that match something
 * that exists, starting at a word boundary and ending at whitespace or the end.
 */
export function detectSentChips(text: string, known: KnownChipLabels): PromptChip[] {
	const chips: PromptChip[] = [];
	const endsWord = (end: number) => end === text.length || /\s/.test(text[end] ?? '');
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		const atBoundary = i === 0 || /\s/.test(text[i - 1] ?? '');
		if (!atBoundary || (ch !== '@' && ch !== '/')) {
			i++;
			continue;
		}
		let chip: PromptChip | undefined;
		if (ch === '/') {
			const cmd = known.commands.find(
				(c) => text.startsWith(c, i) && endsWord(i + c.length),
			);
			if (cmd) chip = { start: i, end: i + cmd.length, kind: 'command' };
		} else {
			const source = known.sources.find(
				(s) => text.startsWith(s, i + 1) && endsWord(i + 1 + s.length),
			);
			if (source) {
				chip = { start: i, end: i + 1 + source.length, kind: 'source' };
			} else {
				// Longest note name first: try every whitespace boundary on this line.
				const lineEnd = text.indexOf('\n', i);
				const rest = text.slice(i + 1, lineEnd === -1 ? text.length : lineEnd);
				const limit = Math.min(rest.length, MAX_NOTE_NAME_LENGTH);
				for (let end = limit; end > 0; end--) {
					if (end < rest.length && !/\s/.test(rest[end] ?? '')) continue;
					const name = rest.slice(0, end);
					if (name.trim() === name && known.isNote(name)) {
						chip = { start: i, end: i + 1 + end, kind: 'file' };
						break;
					}
				}
			}
		}
		if (chip) {
			chips.push(chip);
			i = chip.end;
		} else {
			i++;
		}
	}
	return chips;
}
