import './ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { ContextCompiler } from '../src/core/context/compiler.ts';
import { parseAvailableCommands } from '../src/core/models/antigravity-acp.ts';
import { loadedSkillName } from '../src/core/skills/index.ts';
import {
	ToolRegistry,
	createCreateNoteTool,
} from '../src/core/tools/index.ts';
import { ChangeStagingManager } from '../src/core/transactions/index.ts';
import { McpToolServer } from '../src/core/models/mcp-tool-server.ts';
import { Agent } from '../src/core/agent/index.ts';

test('ContextCompiler deduplicates active note across turns', async () => {
	const compiler = new ContextCompiler({
		vaultService: {
			async getNoteOutline(path) {
				return {
					path,
					headings: [{ heading: 'Overview', level: 2, line: 3 }],
					tags: ['#ai'],
					outgoingLinks: [],
					backlinks: ['Index.md'],
					charCount: 120,
				};
			},
		},
	});

	const turn1 = await compiler.compile(
		'Summarize this note',
		{ activeFile: 'Research/LLM.md' },
		'ask',
	);
	assert.match(turn1.context, /Current Active Note: \[\[LLM\]\]/);
	assert.match(turn1.context, /## Overview/);
	assert.equal(turn1.contextRefs.length, 1);

	// Second turn with identical active note should not duplicate active note
	const turn2 = await compiler.compile(
		'Now list action items',
		{ activeFile: 'Research/LLM.md' },
		'ask',
	);
	assert.equal(turn2.context, undefined);

	// Plan mode adds read-only notice
	const turn3 = await compiler.compile(
		'Propose edits',
		{ activeFile: 'Research/LLM.md' },
		'plan',
	);
	assert.match(turn3.context, /Mode: Plan \(read-only\)/);

	// Reset restores first-turn injection
	compiler.reset();
	const turn4 = await compiler.compile(
		'Fresh session',
		{ activeFile: 'Research/LLM.md' },
		'ask',
	);
	assert.match(turn4.context, /Current Active Note/);
});

test('ContextCompiler sends no context with /compact, then re-sends the active note', async () => {
	const compiler = new ContextCompiler();
	await compiler.compile('hi', { activeFile: 'A.md' });
	const compact = await compiler.compile('/compact', { activeFile: 'A.md' }, 'plan');
	assert.deepEqual(compact, { contextRefs: [] });
	const next = await compiler.compile('next', { activeFile: 'A.md' });
	assert.match(next.context, /Current Active Note: \[\[A\]\]/);
});

test('parseAvailableCommands validates entries and hides commands Antidian cannot run', () => {
	assert.deepEqual(
		parseAvailableCommands([
			{ name: 'compact', description: 'Compact\n  now' },
			{ name: 'my-skill' },
			{ name: 'swarm', description: 'Run a swarm' },
			{ name: 'bad name' },
			{ name: 42 },
			null,
		]),
		[
			{ name: 'compact', description: 'Compact now' },
			{ name: 'my-skill', description: '' },
		],
	);
	assert.deepEqual(parseAvailableCommands({ nope: true }), []);
});

test('loadedSkillName recognizes native skill reads and older load_skill calls', () => {
	assert.equal(loadedSkillName('read_file', { Path: '/v/.agents/skills/daily/SKILL.md' }), 'daily');
	assert.equal(loadedSkillName('read_file', { Path: 'C:\\v\\.agents\\skills\\daily\\SKILL.md' }), 'daily');
	assert.equal(loadedSkillName('read_file', { Path: '/v/note.md' }), undefined);
	assert.equal(loadedSkillName('load_skill', { name: 'daily' }), 'daily');
	assert.equal(loadedSkillName('read_note', undefined), undefined);
});

test('McpToolServer blocks mutating tools in plan mode and allows read tools', async () => {
	const staging = new ChangeStagingManager();
	staging.startTurn();
	const registry = new ToolRegistry();
	registry.register(createCreateNoteTool(staging));
	registry.register({
		name: 'read_stub',
		description: 'Reads',
		schema: { type: 'object', properties: {} },
		execute: async () => ({ ok: true }),
	});

	const server = new McpToolServer(registry);
	const info = await server.start();

	try {
		server.setTurnContext({ permissionMode: 'plan' });

		const callTool = (name, args) =>
			new Promise((resolve, reject) => {
				const body = JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: { name, arguments: args },
				});
				const req = http.request(
					info.url,
					{
						method: 'POST',
						headers: {
							Authorization: `Bearer ${info.token}`,
							'Content-Type': 'application/json',
							'Content-Length': Buffer.byteLength(body),
						},
					},
					(res) => {
						let data = '';
						res.on('data', (chunk) => {
							data += chunk.toString();
						});
						res.on('end', () => {
							try {
								const json = JSON.parse(data);
								resolve(JSON.parse(json.result.content[0].text));
							} catch (err) {
								reject(err);
							}
						});
					},
				);
				req.on('error', reject);
				req.write(body);
				req.end();
			});

		const blocked = await callTool('create_note', {
			path: 'Blocked.md',
			content: 'nope',
		});
		assert.equal(blocked.staged, false);
		assert.equal(blocked.blockedByPlanMode, true);
		assert.equal(staging.getActive()?.operations.length, 0);

		assert.deepEqual(await callTool('read_stub', {}), { ok: true });

		// Aborted turn signal short-circuits tool execution
		const abortController = new AbortController();
		abortController.abort();
		server.setTurnContext({
			permissionMode: 'auto',
			signal: abortController.signal,
		});
		const cancelled = await callTool('create_note', {
			path: 'Cancelled.md',
			content: 'nope',
		});
		assert.equal(cancelled.cancelled, true);
		assert.equal(staging.getActive()?.operations.length, 0);
		// Missing or invalid Bearer token returns 401
		const unauthStatus = await new Promise((resolve, reject) => {
			const req = http.request(
				info.url,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: 'Bearer wrong-token',
					},
				},
				(res) => {
					res.resume();
					res.on('end', () => resolve(res.statusCode));
				},
			);
			req.on('error', reject);
			req.end('{}');
		});
		assert.equal(unauthStatus, 401);
	} finally {
		await server.stop();
	}
});

test('Agent.cancel aborts active turn, forwards cancel to provider, and preserves partial answer', async () => {
	let providerCancelled = false;
	let signalAborted = false;
	let markTurnStarted;
	const turnStarted = new Promise((resolve) => {
		markTurnStarted = resolve;
	});
	const steps = [];

	const fakeProvider = {
		getMcpToolServer: () => undefined,
		cancel() {
			providerCancelled = true;
		},
		async resetSession() {},
		runTurn(_prompt, _media, callbacks, signal) {
			return new Promise((resolve) => {
				callbacks?.onAnswerDelta?.('Partial answer');
				signal?.addEventListener('abort', () => {
					signalAborted = true;
					resolve({ answer: 'Partial answer', stopReason: 'cancelled' });
				});
				markTurnStarted();
			});
		},
	};

	const agent = new Agent({ provider: fakeProvider });
	const runPromise = agent.run('Write a long essay', undefined, [], (evt) => {
		steps.push(evt);
	});

	await turnStarted;
	agent.cancel();

	const result = await runPromise;
	assert.equal(providerCancelled, true);
	assert.equal(signalAborted, true);
	assert.equal(result.cancelled, true);
	assert.equal(result.answer, 'Partial answer');
	assert.ok(steps.some((s) => s.type === 'cancelled'));
	assert.equal(
		steps.some((s) => s.type === 'error'),
		false,
	);
	assert.equal(result.updatedHistory[result.updatedHistory.length - 1]?.text, 'Partial answer');
});
