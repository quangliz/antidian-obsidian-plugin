import './ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	extractMarkdownHeadings,
	extractSection,
	applySectionPatch,
	applyBlockReplace,
	applyAppend,
	applyFrontmatterUpdate,
	parseSimpleFrontmatter,
} from '../src/core/transactions/markdown.ts';

test('extractMarkdownHeadings ignores frontmatter and fenced code blocks', () => {
	const md = [
		'---',
		'title: Test',
		'# not a heading',
		'---',
		'',
		'# Title',
		'Intro text',
		'```markdown',
		'## Fake Heading Inside Fence',
		'```',
		'## Real Section',
		'Body',
		'### Sub Section',
		'Sub body',
	].join('\n');

	const headings = extractMarkdownHeadings(md);
	assert.equal(headings.length, 3);
	assert.deepEqual(
		headings.map((h) => [h.level, h.heading]),
		[
			[1, 'Title'],
			[2, 'Real Section'],
			[3, 'Sub Section'],
		],
	);
});

test('extractSection and applySectionPatch preserve surrounding sections', () => {
	const md = '# Note\n\n## Alpha\nOld alpha\n\n## Beta\nKeep beta\n';
	assert.equal(extractSection(md, 'Alpha'), '## Alpha\nOld alpha');

	const patched = applySectionPatch(md, 'Alpha', 'New alpha content');
	assert.match(patched, /## Alpha\n\nNew alpha content/);
	assert.match(patched, /## Beta\nKeep beta/);
});

test('applyBlockReplace handles exact, missing, and ambiguous matches', () => {
	const md = 'Line A\nTarget block\nLine C\n';
	const ok = applyBlockReplace(md, 'Target block', 'Updated block');
	assert.equal(ok.ok, true);
	if (ok.ok) {
		assert.equal(ok.content, 'Line A\nUpdated block\nLine C\n');
	}

	const missing = applyBlockReplace(md, 'Does not exist', 'X');
	assert.equal(missing.ok, false);
	if (!missing.ok) assert.equal(missing.reason, 'not_found');

	const dup = applyBlockReplace('foo\nbar\nfoo\n', 'foo', 'baz');
	assert.equal(dup.ok, false);
	if (!dup.ok) assert.equal(dup.reason, 'ambiguous');
});

test('applyAppend appends at EOF and under a heading', () => {
	const md = '# Note\n\n## Tasks\n- Task 1\n\n## Notes\nHello\n';

	const underHeading = applyAppend(md, '- Task 2', 'Tasks');
	assert.equal(underHeading.ok, true);
	if (underHeading.ok) {
		assert.match(
			underHeading.content,
			/## Tasks\n- Task 1\n\n- Task 2\n\n## Notes/,
		);
	}

	const eof = applyAppend(md, 'Footer line');
	assert.equal(eof.ok, true);
	if (eof.ok) {
		assert.ok(eof.content.endsWith('Footer line\n'));
	}

	const badHeading = applyAppend(md, 'X', 'Nonexistent');
	assert.equal(badHeading.ok, false);
});

test('applyFrontmatterUpdate creates, updates, and removes YAML keys cleanly', () => {
	const plain = '# Title\n\nBody text\n';
	const added = applyFrontmatterUpdate(plain, {
		status: 'draft',
		tags: ['research', 'ai'],
	});
	assert.ok(
		added.startsWith(
			'---\nstatus: draft\ntags:\n  - research\n  - ai\n---\n\n# Title',
		),
	);

	const updated = applyFrontmatterUpdate(
		added,
		{ status: 'published', rating: 5 },
		['tags'],
	);
	const parsed = parseSimpleFrontmatter(updated);
	assert.equal(parsed?.status, 'published');
	assert.equal(parsed?.rating, 5);
	assert.equal(parsed?.tags, undefined);
	assert.match(updated, /Body text/);
});
