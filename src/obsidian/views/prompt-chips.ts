/**
 * Pure helpers for prompt-bar chips (no Obsidian imports, so they are unit-testable).
 *
 * A chip marks a range of the prompt text that was inserted by picking an
 * autocomplete item (a note, a source, a slash command). Text the user types
 * by hand is never a chip, even if it looks like `/plan` or `@note`.
 */

export type PromptChipKind = 'file' | 'source' | 'command';

export interface PromptChip {
	/** `[start, end)` in the prompt text; excludes the trailing space. */
	start: number;
	end: number;
	kind: PromptChipKind;
}

export interface PromptSegment {
	text: string;
	chip?: PromptChip;
}

/**
 * Re-anchors chips after the text changed from `oldText` to `newText`.
 * The edit is located as the span between the common prefix and suffix:
 * chips entirely before it stay, chips entirely after it shift, and any chip
 * the edit touches inside is dropped (editing a chip turns it into plain text).
 */
export function rebaseChips(
	chips: PromptChip[],
	oldText: string,
	newText: string,
): PromptChip[] {
	if (oldText === newText || chips.length === 0) return chips;

	let prefix = 0;
	const maxPrefix = Math.min(oldText.length, newText.length);
	while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix++;

	let suffix = 0;
	const maxSuffix = Math.min(oldText.length, newText.length) - prefix;
	while (
		suffix < maxSuffix &&
		oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
	) {
		suffix++;
	}

	const editStart = prefix;
	const oldEditEnd = oldText.length - suffix;
	const delta = newText.length - oldText.length;

	const out: PromptChip[] = [];
	for (const chip of chips) {
		if (chip.end <= editStart) {
			out.push(chip);
		} else if (chip.start >= oldEditEnd) {
			out.push({ ...chip, start: chip.start + delta, end: chip.end + delta });
		}
		// Otherwise the edit overlaps the chip: drop it.
	}
	return out;
}

/**
 * The chip a collapsed caret would delete as a whole: Backspace right after a
 * chip, or Delete right before one.
 */
export function chipAtCaret(
	chips: PromptChip[],
	caret: number,
	key: 'Backspace' | 'Delete',
): PromptChip | undefined {
	return chips.find((c) => (key === 'Backspace' ? c.end === caret : c.start === caret));
}

/** Splits text into plain and chip segments, in order, for rendering. */
export function segmentPrompt(text: string, chips: PromptChip[]): PromptSegment[] {
	const sorted = [...chips]
		.filter((c) => c.start >= 0 && c.end <= text.length && c.start < c.end)
		.sort((a, b) => a.start - b.start);
	const segments: PromptSegment[] = [];
	let pos = 0;
	for (const chip of sorted) {
		if (chip.start < pos) continue;
		if (chip.start > pos) segments.push({ text: text.slice(pos, chip.start) });
		segments.push({ text: text.slice(chip.start, chip.end), chip });
		pos = chip.end;
	}
	if (pos < text.length) segments.push({ text: text.slice(pos) });
	return segments;
}
