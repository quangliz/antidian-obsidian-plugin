import './ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChangeStagingManager } from '../src/core/transactions/index.ts';
import { StagedVaultOverlay } from '../src/core/transactions/overlay.ts';
import { ChangeSetValidator } from '../src/core/transactions/validator.ts';
import { ChangeSetDiffGenerator } from '../src/core/transactions/diff.ts';

function createMemoryVault(initialFiles = {}) {
	const files = new Map(Object.entries(initialFiles));
	const mtimes = new Map(
		Object.keys(initialFiles).map((k) => [k, 1000]),
	);

	const normalizePath = (p) => {
		let clean = p.trim().replace(/\\/g, '/').replace(/^\/+/, '');
		const base = clean.split('/').pop() || '';
		if (!base.includes('.')) clean += '.md';
		return clean;
	};

	return {
		files,
		mtimes,
		normalizePath,
		isPathWithinVault(p) {
			const clean = p.trim().replace(/\\/g, '/');
			return !clean.includes('..') && !clean.startsWith('/') && !clean.includes('://');
		},
		async fileExists(p) {
			return files.has(normalizePath(p));
		},
		async getFileMtime(p) {
			return mtimes.get(normalizePath(p)) ?? null;
		},
		async headingExists() {
			return true;
		},
		async searchNotes() {
			return [];
		},
		async readNote({ path }) {
			const norm = normalizePath(path);
			if (!files.has(norm)) return null;
			return {
				path: norm,
				content: files.get(norm),
				mtime: mtimes.get(norm),
			};
		},
		async createNote(path, content) {
			files.set(normalizePath(path), content);
		},
		async patchSection() {},
	};
}

test('StagedVaultOverlay reflects staged create + replace + frontmatter within same turn', async () => {
	const vault = createMemoryVault();
	const staging = new ChangeStagingManager();
	const overlay = new StagedVaultOverlay(vault, staging);

	staging.startTurn();
	staging.stage({
		type: 'create',
		path: 'Projects/Plan.md',
		content: '# Plan\n\n## Goals\n- Draft v1\n',
	});
	staging.stage({
		type: 'replace-block',
		path: 'Projects/Plan.md',
		oldText: '- Draft v1',
		newText: '- Final v2',
	});
	staging.stage({
		type: 'update-frontmatter',
		path: 'Projects/Plan.md',
		set: { status: 'active', tags: ['project'] },
	});

	const note = await overlay.readEffectiveNote({ path: 'Projects/Plan.md' });
	assert.ok(note);
	assert.equal(note.isStaged, true);
	assert.match(note.content, /status: active/);
	assert.match(note.content, /- Final v2/);

	const outline = await overlay.getEffectiveOutline('Projects/Plan.md');
	assert.ok(outline);
	assert.equal(outline.isStaged, true);
	assert.deepEqual(
		outline.headings.map((h) => h.heading),
		['Plan', 'Goals'],
	);
	assert.ok(outline.tags.includes('#project'));
});

test('ChangeSetValidator accepts sequential staged edits and catches errors', async () => {
	const vault = createMemoryVault({
		'Notes/A.md': '# A\n\nParagraph 1\n\nParagraph 2\n',
	});
	const validator = new ChangeSetValidator(vault);

	// Valid sequence: create new file then append to it
	const validRes = await validator.validate({
		id: 'cs_1',
		createdAt: Date.now(),
		status: 'staged',
		operations: [
			{ type: 'create', path: 'Notes/New.md', content: '# New\n\n## Log\nStart\n' },
			{ type: 'append', path: 'Notes/New.md', heading: 'Log', content: 'Entry 2' },
		],
	});
	assert.equal(validRes.valid, true);

	// Invalid: path traversal & missing replace-block target
	const invalidRes = await validator.validate({
		id: 'cs_2',
		createdAt: Date.now(),
		status: 'staged',
		operations: [
			{ type: 'create', path: '../escape.md', content: 'bad' },
			{
				type: 'replace-block',
				path: 'Notes/A.md',
				oldText: 'Missing text',
				newText: 'Replacement',
			},
		],
	});
	assert.equal(invalidRes.valid, false);
	assert.deepEqual(
		invalidRes.errors.map((e) => e.code),
		['path_traversal', 'target_not_found'],
	);
});

test('ChangeSetDiffGenerator computes diffs sequentially across operations', async () => {
	const vault = createMemoryVault({
		'Notes/A.md': '# A\n\nHello world\n',
	});
	const generator = new ChangeSetDiffGenerator(vault);

	const diff = await generator.generate({
		id: 'cs_diff',
		createdAt: Date.now(),
		status: 'staged',
		operations: [
			{
				type: 'replace-block',
				path: 'Notes/A.md',
				oldText: 'Hello world',
				newText: 'Hello Obsidian',
			},
			{
				type: 'update-frontmatter',
				path: 'Notes/A.md',
				set: { reviewed: true },
			},
		],
	});

	assert.equal(diff.files.length, 2);
	assert.equal(diff.files[0]?.operationType, 'replace-block');
	assert.equal(diff.files[1]?.operationType, 'update-frontmatter');
	assert.ok(diff.totalAdditions > 0);
});
