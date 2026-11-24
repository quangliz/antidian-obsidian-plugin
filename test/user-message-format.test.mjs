import './ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	parseUserMessage,
	selectionChipLabel,
} from '../src/obsidian/views/user-message-format.ts';

test('parseUserMessage splits leading selection blocks from the typed text', () => {
	const text = 'From [[dien-toan]] (L1197):\n> line one\n>\n> line three\n\nSelected text (L3-5):\n> other\n\nsolve this';
	const parsed = parseUserMessage(text);
	assert.deepEqual(parsed.selections, [
		{ note: 'dien-toan', startLine: 1197, text: 'line one\n\nline three' },
		{ startLine: 3, endLine: 5, text: 'other' },
	]);
	assert.equal(parsed.body, 'solve this');
	assert.equal(selectionChipLabel(parsed.selections[0]), 'dien-toan:1197');
	assert.equal(selectionChipLabel(parsed.selections[1]), 'Selection:3-5');
});

test('parseUserMessage leaves ordinary text alone', () => {
	for (const text of ['hello', 'From [[x]]:\nno quote', '> just a quote', 'ask\nFrom [[x]]:\n> q']) {
		assert.deepEqual(parseUserMessage(text), { selections: [], body: text });
	}
	assert.deepEqual(parseUserMessage('From [[x]]:\n> q'), {
		selections: [{ note: 'x', text: 'q' }],
		body: '',
	});
});

test('detectSentChips finds known sources, commands and notes at word boundaries', async () => {
	const { detectSentChips } = await import('../src/obsidian/views/user-message-format.ts');
	const known = {
		sources: ['Web search'],
		commands: ['/plan', '/search'],
		isNote: (name) => ['Quantum notes', 'Quantum'].includes(name),
	};
	const text = '@Web search /plan @Quantum notes about it';
	assert.deepEqual(detectSentChips(text, known), [
		{ start: 0, end: 11, kind: 'source' },
		{ start: 12, end: 17, kind: 'command' },
		{ start: 18, end: 32, kind: 'file' },
	]);
	// Not at a boundary, not followed by whitespace, or unknown: plain text.
	assert.deepEqual(detectSentChips('a/plan /planning mail@Quantum @Nope /x', known), []);
	assert.deepEqual(detectSentChips('see @Quantum', known), [{ start: 4, end: 12, kind: 'file' }]);
});
