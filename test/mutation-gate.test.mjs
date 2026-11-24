import './ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChangeStagingManager } from '../src/core/transactions/index.ts';
import { ChangeSetValidator } from '../src/core/transactions/validator.ts';
import { ChangeSetDiffGenerator } from '../src/core/transactions/diff.ts';
import { MutationGate } from '../src/core/transactions/gate.ts';
import { applyOperationToContent } from '../src/core/transactions/overlay.ts';

function createVault(initialFiles) {
	const files = new Map(Object.entries(initialFiles));
	const mtimes = new Map(Object.keys(initialFiles).map((k) => [k, 1000]));
	const normalizePath = (p) => {
		let clean = p.trim().replace(/\\/g, '/').replace(/^\/+/, '');
		if (!(clean.split('/').pop() || '').includes('.')) clean += '.md';
		return clean;
	};
	return {
		files,
		mtimes,
		normalizePath,
		isPathWithinVault: (p) => !p.includes('..') && !p.startsWith('/'),
		fileExists: async (p) => files.has(normalizePath(p)),
		getFileMtime: async (p) => mtimes.get(normalizePath(p)) ?? null,
		headingExists: async () => true,
		searchNotes: async () => [],
		readNote: async ({ path }) => {
			const norm = normalizePath(path);
			return files.has(norm)
				? { path: norm, content: files.get(norm), mtime: mtimes.get(norm) }
				: null;
		},
	};
}

/** Applies ops to the in-memory vault, like ChangeSetApplicator would. */
function createApplicator(vault) {
	const applied = [];
	return {
		applied,
		async apply(changeSet) {
			for (const op of changeSet.operations) {
				const norm = vault.normalizePath(op.path);
				const result = applyOperationToContent(vault.files.get(norm) ?? null, op);
				if (!result.ok) throw new Error('apply failed');
				vault.files.set(norm, result.content);
				vault.mtimes.set(norm, (vault.mtimes.get(norm) ?? 0) + 1000);
			}
			applied.push(changeSet);
			return { id: changeSet.id, appliedAt: Date.now(), operations: [] };
		},
	};
}

function setup() {
	const vault = createVault({ 'Note.md': '# Note\n\nVersion 1 — 10/11/2026\n' });
	const staging = new ChangeStagingManager();
	const applicator = createApplicator(vault);
	const gate = new MutationGate({
		staging,
		validator: new ChangeSetValidator(vault),
		diffGenerator: new ChangeSetDiffGenerator(vault),
		applicator,
		vault,
	});
	const turn = staging.startTurn();
	return { vault, staging, applicator, gate, turn };
}

/** Stage a replace like the replace_block tool does and return its tool output. */
function stageReplace(staging, baseMtime = 1000) {
	const changeSet = staging.stage({
		type: 'replace-block',
		path: 'Note.md',
		oldText: '10/11/2026',
		newText: '24/11/2026',
		baseMtime,
	});
	return {
		staged: true,
		changeSetId: changeSet.id,
		operationId: changeSet.operations[changeSet.operations.length - 1]?.id,
	};
}

const call = (output) => ({ callId: 'mcp-1', toolName: 'replace_block', toolArgs: {}, output });

test('ask mode: approved write is applied at call time and leaves the turn ChangeSet', async () => {
	const { vault, staging, applicator, gate, turn } = setup();
	const requests = [];
	const mtimes = new Map();

	const result = await gate.review(call(stageReplace(staging)), {
		mode: 'ask',
		requestApproval: async (req) => {
			requests.push(req);
			return 'approve';
		},
		recordReadMtime: (path, mtime) => mtimes.set(path, mtime),
	});

	assert.equal(requests.length, 1);
	assert.equal(requests[0].callId, 'mcp-1');
	assert.equal(requests[0].diff.deletions, 1);
	assert.equal(result.applied, true);
	assert.ok(result._diff, 'diff is attached for the UI');
	assert.equal(applicator.applied.length, 1);
	assert.equal(applicator.applied[0].operations.length, 1);
	assert.match(vault.files.get('Note.md'), /24\/11\/2026/);
	assert.equal(turn.operations.length, 0, 'op no longer pending in the turn');
	assert.equal(mtimes.get('Note.md'), 2000, 'read mtime refreshed after apply');
});

test('ask mode: rejected write is discarded and reported to the model', async () => {
	const { vault, staging, applicator, gate, turn } = setup();

	const result = await gate.review(call(stageReplace(staging)), {
		mode: 'ask',
		requestApproval: async () => 'reject',
	});

	assert.equal(result.rejectedByUser, true);
	assert.equal(result.applied, false);
	assert.equal(applicator.applied.length, 0);
	assert.match(vault.files.get('Note.md'), /10\/11\/2026/);
	assert.equal(turn.operations.length, 0);
});

test('auto mode applies valid writes without asking', async () => {
	const { staging, applicator, gate } = setup();
	let asked = false;

	const result = await gate.review(call(stageReplace(staging)), {
		mode: 'auto',
		requestApproval: async () => {
			asked = true;
			return 'reject';
		},
	});

	assert.equal(asked, false);
	assert.equal(result.applied, true);
	assert.equal(result.autoApproved, true);
	assert.equal(applicator.applied.length, 1);
});

test('invalid writes are discarded before asking the user', async () => {
	const { staging, applicator, gate } = setup();
	let asked = false;

	// Read at mtime 500, but the file is at 1000: stale base.
	const result = await gate.review(call(stageReplace(staging, 500)), {
		mode: 'ask',
		requestApproval: async () => {
			asked = true;
			return 'approve';
		},
	});

	assert.equal(asked, false);
	assert.equal(result.applied, false);
	assert.match(result.error, /stale_base/);
	assert.equal(applicator.applied.length, 0);
});

test('a failing approval handler counts as a rejection', async () => {
	const { staging, applicator, gate } = setup();

	const result = await gate.review(call(stageReplace(staging)), {
		mode: 'ask',
		requestApproval: async () => {
			throw new Error('view closed');
		},
	});

	assert.equal(result.rejectedByUser, true);
	assert.equal(applicator.applied.length, 0);
});

test('without a reviewer in ask mode the write stays staged', async () => {
	const { staging, gate, turn } = setup();
	const output = stageReplace(staging);

	const result = await gate.review(call(output), { mode: 'ask' });

	assert.deepEqual(result, output);
	assert.equal(turn.operations.length, 1);
});
