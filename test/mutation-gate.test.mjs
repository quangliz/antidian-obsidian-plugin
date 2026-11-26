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

/** Ask-mode options whose decision is resolved by the test; `decided` gets the final output. */
function askOptions(extra = {}) {
	let decide;
	const requests = [];
	let settle;
	const decided = new Promise((resolve) => {
		settle = resolve;
	});
	const options = {
		mode: 'ask',
		requestApproval: (req) => {
			requests.push(req);
			return new Promise((resolve) => {
				decide = resolve;
			});
		},
		onDecided: (callId, output) => settle({ callId, output }),
		...extra,
	};
	return { options, requests, decided, decide: (d) => decide(d) };
}

test('ask mode: the tool returns pending at once, then the approved write is applied', async () => {
	const { vault, staging, applicator, gate, turn } = setup();
	const mtimes = new Map();
	const ask = askOptions({ recordReadMtime: (path, mtime) => mtimes.set(path, mtime) });

	const pending = await gate.review(call(stageReplace(staging)), ask.options);

	assert.equal(pending.pendingApproval, true);
	assert.equal(pending.applied, false);
	assert.ok(pending._diff, 'diff is attached for the UI');
	assert.equal(ask.requests.length, 1, 'the user was asked before the tool returned');
	assert.equal(ask.requests[0].callId, 'mcp-1');
	assert.equal(ask.requests[0].diff.deletions, 1);
	assert.equal(applicator.applied.length, 0, 'nothing applied before the decision');
	assert.equal(turn.operations.length, 0, 'op no longer pending in the turn');

	ask.decide('approve');
	const { callId, output } = await ask.decided;

	assert.equal(callId, 'mcp-1');
	assert.equal(output.applied, true);
	assert.equal(applicator.applied.length, 1);
	assert.match(vault.files.get('Note.md'), /24\/11\/2026/);
	assert.equal(mtimes.get('Note.md'), 2000, 'read mtime refreshed after apply');
	assert.match(gate.takeReviewNotes(), /`replace_block` on `Note.md`: approved and applied/);
	assert.equal(gate.takeReviewNotes(), undefined, 'each decision is reported once');
});

test('ask mode: rejected write is discarded and reported to the model', async () => {
	const { vault, staging, applicator, gate } = setup();
	const ask = askOptions();

	await gate.review(call(stageReplace(staging)), ask.options);
	ask.decide('reject');
	const { output } = await ask.decided;

	assert.equal(output.rejectedByUser, true);
	assert.equal(output.applied, false);
	assert.equal(applicator.applied.length, 0);
	assert.match(vault.files.get('Note.md'), /10\/11\/2026/);
	assert.match(gate.takeReviewNotes(), /rejected by the user/);
});

test('ask mode: a file with a change awaiting approval refuses further edits until decided', async () => {
	const { staging, gate } = setup();
	const ask = askOptions();

	await gate.review(call(stageReplace(staging)), ask.options);
	assert.match(gate.takeReviewNotes({ includeAwaiting: true }), /Still waiting for the user's decision: `Note.md`/);

	const second = await gate.review(call(stageReplace(staging)), askOptions().options);
	assert.equal(second.applied, false);
	assert.match(second.error, /waiting for the user's decision/);

	ask.decide('reject');
	await ask.decided;
	const third = await gate.review(call(stageReplace(staging)), askOptions().options);
	assert.equal(third.pendingApproval, true, 'the file is editable again once decided');
});

test('ask mode: a write approved after its note changed is not applied', async () => {
	const { vault, staging, applicator, gate } = setup();
	const ask = askOptions();

	await gate.review(call(stageReplace(staging)), ask.options);
	vault.mtimes.set('Note.md', 5000); // the user edited the note meanwhile
	ask.decide('approve');
	const { output } = await ask.decided;

	assert.equal(output.applied, false);
	assert.match(output.error, /changed before it was approved/);
	assert.equal(applicator.applied.length, 0);
	assert.match(gate.takeReviewNotes(), /approved but not applied/);
});

test('forgetDecisions drops decisions from an ended session', async () => {
	const { staging, gate } = setup();
	const ask = askOptions();

	await gate.review(call(stageReplace(staging)), ask.options);
	ask.decide('reject');
	await ask.decided;
	gate.forgetDecisions();

	assert.equal(gate.takeReviewNotes({ includeAwaiting: true }), undefined);
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
	let settle;
	const decided = new Promise((resolve) => {
		settle = resolve;
	});

	await gate.review(call(stageReplace(staging)), {
		mode: 'ask',
		requestApproval: async () => {
			throw new Error('view closed');
		},
		onDecided: (_callId, output) => settle(output),
	});

	assert.equal((await decided).rejectedByUser, true);
	assert.equal(applicator.applied.length, 0);
});

test('without a reviewer in ask mode the write stays staged', async () => {
	const { staging, gate, turn } = setup();
	const output = stageReplace(staging);

	const result = await gate.review(call(output), { mode: 'ask' });

	assert.deepEqual(result, output);
	assert.equal(turn.operations.length, 1);
});
