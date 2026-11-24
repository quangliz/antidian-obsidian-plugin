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
