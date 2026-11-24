import './ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { ContextCompiler } from '../src/core/context/compiler.ts';
import {
	ToolRegistry,
	createCreateNoteTool,
	createListSkillsTool,
} from '../src/core/tools/index.ts';
import { ChangeStagingManager } from '../src/core/transactions/index.ts';
import { McpToolServer } from '../src/core/models/mcp-tool-server.ts';
import { Agent } from '../src/core/agent/index.ts';

test('ContextCompiler deduplicates active note across turns and injects skills once', async () => {
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
		skillService: {
			async listSkills() {
				return [
					{
						name: 'daily-review',
						description: 'Summarize daily notes',
						path: '.anti-dian/skills/daily-review.md',
					},
				];
			},
			async loadSkill() {
				return null;
			},
		},
	});

	const turn1 = await compiler.compile(
		'Summarize this note',
		{ activeFile: 'Research/LLM.md' },
		'ask',
	);
	assert.match(turn1.prompt, /Available Vault Skills/);
	assert.match(turn1.prompt, /daily-review: Summarize daily notes/);
	assert.match(turn1.prompt, /Current Active Note: \[\[LLM\]\]/);
	assert.match(turn1.prompt, /## Overview/);
	assert.equal(turn1.contextRefs.length, 1);

	// Second turn with identical active note should not duplicate active note or skills
	const turn2 = await compiler.compile(
		'Now list action items',
		{ activeFile: 'Research/LLM.md' },
		'ask',
	);
	assert.doesNotMatch(turn2.prompt, /Available Vault Skills/);
	assert.doesNotMatch(turn2.prompt, /Current Active Note/);
	assert.equal(turn2.prompt, 'Now list action items');

	// Plan mode adds read-only notice
	const turn3 = await compiler.compile(
		'Propose edits',
		{ activeFile: 'Research/LLM.md' },
		'plan',
	);
	assert.match(turn3.prompt, /Mode: Plan \(read-only\)/);

	// Reset restores first-turn injection
	compiler.reset();
	const turn4 = await compiler.compile(
		'Fresh session',
		{ activeFile: 'Research/LLM.md' },
		'ask',
	);
	assert.match(turn4.prompt, /Available Vault Skills/);
	assert.match(turn4.prompt, /Current Active Note/);
});

test('ContextCompiler explicitly reports when no vault skills are configured', async () => {
	const compiler = new ContextCompiler({
		skillService: {
			async listSkills() {
				return [];
			},
			async loadSkill() {
				return null;
			},
		},
	});

	const turn1 = await compiler.compile('Update metadata', undefined, 'ask');
	assert.match(turn1.prompt, /\[Vault Skills: none configured\]/);

	const turn2 = await compiler.compile('Follow-up', undefined, 'ask');
	assert.equal(turn2.prompt, 'Follow-up');
});

test('McpToolServer blocks mutating tools in plan mode and allows read tools', async () => {
	const staging = new ChangeStagingManager();
	staging.startTurn();
	const registry = new ToolRegistry();
	registry.register(createCreateNoteTool(staging));
	registry.register(
		createListSkillsTool({
			async listSkills() {
				return [
					{
						name: 'test-skill',
						description: 'Test',
						path: '.anti-dian/skills/test-skill.md',
					},
				];
			},
			async loadSkill() {
				return null;
			},
		}),
	);

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

		const skills = await callTool('list_skills', {});
		assert.equal(skills.length, 1);
		assert.equal(skills[0].name, 'test-skill');

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
