import './ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	chipAtCaret,
	rebaseChips,
	segmentPrompt,
} from '../src/obsidian/views/prompt-chips.ts';

const chip = (start, end, kind = 'file') => ({ start, end, kind });

test('rebaseChips keeps chips before the edit and shifts chips after it', () => {
	const old = 'see @Note and /plan ';
	const chips = [chip(4, 9), chip(14, 19, 'command')];
	// Typing at the end leaves both chips alone.
	assert.deepEqual(rebaseChips(chips, old, `${old}now`), chips);
	// Typing at the start shifts both.
	assert.deepEqual(rebaseChips(chips, old, `I ${old}`), [chip(6, 11), chip(16, 21, 'command')]);
	// Typing right after a chip (at its end) keeps it.
	assert.deepEqual(rebaseChips(chips, old, 'see @Note! and /plan '), [chip(4, 9), chip(15, 20, 'command')]);
});

test('rebaseChips drops a chip when the edit touches its inside', () => {
	const old = 'see @Note and /plan ';
	const chips = [chip(4, 9), chip(14, 19, 'command')];
	assert.deepEqual(rebaseChips(chips, old, 'see @Nxote and /plan '), [chip(15, 20, 'command')]);
	assert.deepEqual(rebaseChips(chips, old, 'see @Note and /pla '), [chip(4, 9)]);
	// Replacing everything drops all chips.
	assert.deepEqual(rebaseChips(chips, old, 'hello'), []);
});

test('chipAtCaret finds the chip Backspace/Delete would remove whole', () => {
	const chips = [chip(4, 9)];
	assert.deepEqual(chipAtCaret(chips, 9, 'Backspace'), chip(4, 9));
	assert.equal(chipAtCaret(chips, 10, 'Backspace'), undefined);
	assert.deepEqual(chipAtCaret(chips, 4, 'Delete'), chip(4, 9));
	assert.equal(chipAtCaret(chips, 9, 'Delete'), undefined);
});

test('segmentPrompt splits plain text and chips in order', () => {
	const text = 'see @Note and /plan ';
	assert.deepEqual(
		segmentPrompt(text, [chip(14, 19, 'command'), chip(4, 9)]).map((s) => [s.text, s.chip?.kind ?? null]),
		[['see ', null], ['@Note', 'file'], [' and ', null], ['/plan', 'command'], [' ', null]],
	);
	// Out-of-range chips are ignored.
	assert.deepEqual(segmentPrompt('hi', [chip(1, 9)]), [{ text: 'hi' }]);
});
