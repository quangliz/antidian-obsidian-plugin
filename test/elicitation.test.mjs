import './ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	buildElicitationResponse,
	isFieldAnswered,
	parseAskQuestionOutcome,
	parseElicitationRequest,
	parseOptionLabel,
} from '../src/core/models/elicitation.ts';
import { AntigravityAcpClient } from '../src/core/models/antigravity-acp.ts';
import { Agent } from '../src/core/agent/index.ts';

test('parseOptionLabel extracts (Recommended) prefix cleanly', () => {
	assert.deepEqual(parseOptionLabel('(Recommended) Markdown'), {
		label: 'Markdown',
		recommended: true,
	});
	assert.deepEqual(parseOptionLabel('(recommended)  Split by topic '), {
		label: 'Split by topic',
		recommended: true,
	});
	assert.deepEqual(parseOptionLabel('Plain text'), {
		label: 'Plain text',
		recommended: false,
	});
	assert.deepEqual(parseOptionLabel('(Recommended)'), {
		label: '(Recommended)',
		recommended: false,
	});
});

test('parseElicitationRequest pairs agy ask_question single/multi fields with _other write-ins', () => {
	const parsed = parseElicitationRequest({
		sessionId: 'sess-1',
		toolCallId: 'call_123',
		mode: 'form',
		message: 'The agent has 2 questions.',
		requestedSchema: {
			type: 'object',
			properties: {
				q1: {
					type: 'string',
					title: 'Preferred note format?',
					oneOf: [
						{ const: '1', title: '(Recommended) Daily note' },
						{ const: '2', title: 'Topic note' },
					],
				},
				q1_other: {
					type: 'string',
					title: 'Other',
					description: 'Optional free-form answer to: Preferred note format?',
				},
				q2: {
					type: 'array',
					title: 'Sections to include?',
					items: {
						anyOf: [
							{ const: '1', title: 'Summary' },
							{ const: '2', title: 'Action items' },
							{ const: '3', title: 'Links' },
						],
					},
				},
				q2_other: {
					type: 'string',
					title: 'Other',
					description: 'Optional free-form answer to: Sections to include?',
				},
			},
		},
	});

	assert.equal(parsed.unsupportedMode, undefined);
	assert.ok(parsed.request);
	assert.equal(parsed.request.toolCallId, 'call_123');
	assert.equal(parsed.request.fields.length, 2);

	const [q1, q2] = parsed.request.fields;
	assert.equal(q1.kind, 'single-select');
	assert.equal(q1.key, 'q1');
	assert.equal(q1.otherKey, 'q1_other');
	assert.deepEqual(q1.options, [
		{ value: '1', label: 'Daily note', recommended: true },
		{ value: '2', label: 'Topic note' },
	]);

	assert.equal(q2.kind, 'multi-select');
	assert.equal(q2.key, 'q2');
	assert.equal(q2.otherKey, 'q2_other');
	assert.equal(q2.options?.length, 3);
});

test('parseElicitationRequest rejects unsupported modes and supports generic primitive fields', () => {
	const urlReq = parseElicitationRequest({
		mode: 'url',
		message: 'Sign in',
		url: 'https://example.com/auth',
	});
	assert.equal(urlReq.request, null);
	assert.equal(urlReq.unsupportedMode, 'url');

	const emptyReq = parseElicitationRequest({
		mode: 'form',
		requestedSchema: { type: 'object', properties: {} },
	});
	assert.equal(emptyReq.request, null);

	const generic = parseElicitationRequest({
		mode: 'form',
		requestedSchema: {
			type: 'object',
			required: ['folder'],
			properties: {
				folder: { type: 'string', title: 'Target folder' },
				limit: { type: 'integer', title: 'Max notes' },
				overwrite: { type: 'boolean', title: 'Overwrite existing?' },
				style: {
					type: 'string',
					title: 'Style',
					enum: ['brief', 'detailed'],
					enumNames: ['Brief', 'Detailed'],
				},
			},
		},
	});
	assert.ok(generic.request);
	assert.deepEqual(
		generic.request.fields.map((f) => [f.key, f.kind, f.required]),
		[
			['folder', 'text', true],
			['limit', 'number', false],
			['overwrite', 'boolean', false],
			['style', 'single-select', false],
		],
	);
});

test('buildElicitationResponse encodes preset, Other write-in, multi-select, and primitive answers', () => {
	const { request } = parseElicitationRequest({
		mode: 'form',
		requestedSchema: {
			type: 'object',
			properties: {
				q1: {
					type: 'string',
					title: 'Format',
					oneOf: [
						{ const: '1', title: '(Recommended) Markdown' },
						{ const: '2', title: 'Plain text' },
					],
				},
				q1_other: { type: 'string', title: 'Other' },
				q2: {
					type: 'array',
					title: 'Tags',
					items: {
						anyOf: [
							{ const: '1', title: 'Work' },
							{ const: '2', title: 'Personal' },
						],
					},
				},
				q2_other: { type: 'string', title: 'Other' },
				count: { type: 'integer', title: 'Count' },
				confirm: { type: 'boolean', title: 'Confirm' },
			},
		},
	});
	assert.ok(request);

	// Single-select "Other" omits q1 and sends q1_other; multi-select combines preset + Other.
	const drafts = {
		q1: { selectedValues: [], otherSelected: true, otherText: 'Obsidian Canvas' },
		q2: { selectedValues: ['1'], otherSelected: true, otherText: 'Research' },
		count: { textValue: '5' },
		confirm: { booleanValue: true },
	};

	for (const field of request.fields) {
		assert.equal(isFieldAnswered(field, drafts[field.key]), true);
	}
	assert.equal(
		isFieldAnswered(request.fields[0], { otherSelected: true, otherText: '   ' }),
		false,
	);

	const res = buildElicitationResponse(request, drafts);
	assert.equal(res.action, 'accept');
	assert.deepEqual(res.content, {
		q1_other: 'Obsidian Canvas',
		q2: ['1'],
		q2_other: 'Research',
		count: 5,
		confirm: true,
	});
	assert.deepEqual(res.summary, [
		{ question: 'Format', answer: 'Obsidian Canvas' },
		{ question: 'Tags', answer: 'Work, Research' },
		{ question: 'Count', answer: '5' },
		{ question: 'Confirm', answer: 'Yes' },
	]);
});

test('parseAskQuestionOutcome handles live structured outcomes and replayed agy transcript strings', () => {
	assert.deepEqual(
		parseAskQuestionOutcome(undefined, {
			action: 'accept',
			answers: [{ question: 'Color?', answer: 'Blue' }],
		}),
		{ action: 'accept', answers: [{ question: 'Color?', answer: 'Blue' }] },
	);
	assert.deepEqual(parseAskQuestionOutcome(undefined, { action: 'decline' }), {
		action: 'decline',
		answers: [],
	});

	const replayed = parseAskQuestionOutcome(
		{
			questions: [
				{ question: 'Pick a color:', options: ['Red', 'Blue'], is_multi_select: false },
				{ question: 'Pick fruits:', options: ['Apple', 'Banana'], is_multi_select: true },
			],
		},
		'A1: Blue\nA2: Apple, Mango',
	);
	assert.deepEqual(replayed, {
		action: 'accept',
		answers: [
			{ question: 'Pick a color:', answer: 'Blue' },
			{ question: 'Pick fruits:', answer: 'Apple, Mango' },
		],
	});
});

test('AntigravityAcpClient advertises elicitation.form and completes elicitation/create round-trip', async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-dian-elicit-'));
	const fakeBin = path.join(tmpDir, 'fake-agy.mjs');
	fs.writeFileSync(
		fakeBin,
		`#!/usr/bin/env node
import * as readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
let seenInitCaps = null;
let promptReqId = null;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
rl.on('line', (line) => {
	const msg = JSON.parse(line);
	if (msg.method === 'initialize') {
		seenInitCaps = msg.params?.clientCapabilities;
		send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
		return;
	}
	if (msg.method === 'session/new') {
		send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-fake', models: { availableModels: [] } } });
		return;
	}
	if (msg.method === 'session/prompt') {
		promptReqId = msg.id;
		send({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId: 'sess-fake',
				update: {
					sessionUpdate: 'tool_call',
					toolCallId: 'call_q',
					name: 'ask_question',
					args: { questions: [{ question: 'Color?', options: ['Red', 'Blue'], is_multi_select: false }] },
					status: 'in_progress',
				},
			},
		});
		send({
			jsonrpc: '2.0',
			id: 'elicit-1',
			method: 'elicitation/create',
			params: {
				sessionId: 'sess-fake',
				toolCallId: 'call_q',
				mode: 'form',
				message: 'The agent has a question.',
				requestedSchema: {
					type: 'object',
					properties: {
						q1: {
							type: 'string',
							title: 'Color?',
							oneOf: [
								{ const: '1', title: 'Red' },
								{ const: '2', title: 'Blue' },
							],
						},
						q1_other: { type: 'string', title: 'Other' },
					},
				},
			},
		});
		return;
	}
	if (msg.id === 'elicit-1') {
		send({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId: 'sess-fake',
				update: {
					sessionUpdate: 'tool_call_update',
					toolCallId: 'call_q',
					name: 'ask_question',
					status: 'completed',
				},
			},
		});
		send({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId: 'sess-fake',
				update: {
					sessionUpdate: 'agent_message_chunk',
					content: {
						type: 'text',
						text: JSON.stringify({ caps: seenInitCaps, reply: msg.result }),
					},
				},
			},
		});
		send({ jsonrpc: '2.0', id: promptReqId, result: { stopReason: 'end_turn' } });
	}
});
`,
		{ mode: 0o755 },
	);

	const client = new AntigravityAcpClient({
		cliPath: fakeBin,
		cwd: tmpDir,
		quotaFetcher: async () => null,
	});
	const toolEnds = [];
	const receivedRequests = [];

	try {
		const res = await client.prompt('Ask me a color', undefined, {
			onToolEnd: (toolName, toolOutput, callId) => {
				toolEnds.push({ toolName, toolOutput, callId });
			},
			onElicitation: async (req) => {
				receivedRequests.push(req);
				return buildElicitationResponse(req, { q1: { selectedValues: ['2'] } });
			},
		});

		assert.equal(receivedRequests.length, 1);
		assert.equal(receivedRequests[0].fields[0].title, 'Color?');

		const echoed = JSON.parse(res.answer);
		assert.deepEqual(echoed.caps, { elicitation: { form: {} } });
		assert.deepEqual(echoed.reply, { action: 'accept', content: { q1: '2' } });

		assert.equal(toolEnds.length, 1);
		assert.equal(toolEnds[0].toolName, 'ask_question');
		assert.deepEqual(toolEnds[0].toolOutput, {
			action: 'accept',
			answers: [{ question: 'Color?', answer: 'Blue' }],
		});
	} finally {
		await client.destroy();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('Agent forwards requestElicitation callback to provider.runTurn', async () => {
	let capturedHandler;
	const fakeProvider = {
		getMcpToolServer: () => undefined,
		cancel() {},
		async resetSession() {},
		async runTurn(_prompt, _media, callbacks) {
			capturedHandler = callbacks?.onElicitation;
			return { answer: 'done', stopReason: 'end_turn' };
		},
	};
	const handler = async () => ({ action: 'decline' });
	const agent = new Agent({ provider: fakeProvider });

	await agent.run(
		'help me choose',
		undefined,
		[],
		undefined,
		undefined,
		undefined,
		'plan',
		undefined,
		undefined,
		handler,
	);
	assert.equal(capturedHandler, handler);
});
