import './ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	formatElapsedSeconds,
	getActivePlanFocus,
	normalizePlanStepStatus,
	parseFocusText,
	parsePlanSteps,
} from '../src/core/models/plan.ts';
import {
	AntigravityAcpClient,
	applyReplayUpdate,
} from '../src/core/models/antigravity-acp.ts';
import { TurnTraceRecorder } from '../src/core/sessions/trace.ts';
import { Agent } from '../src/core/agent/index.ts';
import { ToolRegistry, createUpdateFocusTool } from '../src/core/tools/index.ts';
import { McpToolServer } from '../src/core/models/mcp-tool-server.ts';
import * as http from 'node:http';

test('normalizePlanStepStatus maps agy and ACP statuses cleanly', () => {
	assert.equal(normalizePlanStepStatus('done'), 'done');
	assert.equal(normalizePlanStepStatus('completed'), 'done');
	assert.equal(normalizePlanStepStatus('in_progress'), 'in_progress');
	assert.equal(normalizePlanStepStatus('running'), 'in_progress');
	assert.equal(normalizePlanStepStatus('skipped'), 'skipped');
	assert.equal(normalizePlanStepStatus('cancelled'), 'skipped');
	assert.equal(normalizePlanStepStatus('failed'), 'failed');
	assert.equal(normalizePlanStepStatus('error'), 'failed');
	assert.equal(normalizePlanStepStatus('pending'), 'pending');
	assert.equal(normalizePlanStepStatus('unknown'), 'pending');
	assert.equal(normalizePlanStepStatus(null), 'pending');
});

test('parsePlanSteps parses update_steps and ACP plan entries while filtering malformed rows', () => {
	const fromUpdateSteps = parsePlanSteps({
		steps: [
			{ title: 'Read roadmap', status: 'done' },
			{ title: '  Draft outline  ', status: 'in_progress' },
			{ title: '', status: 'pending' },
			null,
		],
	});
	assert.deepEqual(fromUpdateSteps, [
		{ title: 'Read roadmap', status: 'done' },
		{ title: 'Draft outline', status: 'in_progress' },
	]);

	const fromAcpPlan = parsePlanSteps({
		entries: [
			{ content: 'Inspect vault', status: 'completed', priority: 'high' },
			{ content: 'Apply edits', status: 'pending' },
		],
	});
	assert.deepEqual(fromAcpPlan, [
		{ title: 'Inspect vault', status: 'done' },
		{ title: 'Apply edits', status: 'pending' },
	]);
});

test('parseFocusText, getActivePlanFocus, and formatElapsedSeconds work on edge cases', () => {
	assert.equal(parseFocusText({ focus: '  Checking notes ' }), 'Checking notes');
	assert.equal(parseFocusText({ focus: '   ' }), null);
	assert.equal(parseFocusText('Inspecting diff'), 'Inspecting diff');

	assert.equal(
		getActivePlanFocus([
			{ title: 'Step 1', status: 'done' },
			{ title: 'Step 2', status: 'in_progress' },
			{ title: 'Step 3', status: 'pending' },
		]),
		'Step 2',
	);
	assert.equal(
		getActivePlanFocus([{ title: 'Step 1', status: 'done' }]),
		null,
	);

	assert.equal(formatElapsedSeconds(0), '0s');
	assert.equal(formatElapsedSeconds(20_400), '20s');
	assert.equal(formatElapsedSeconds(60_000), '1m');
	assert.equal(formatElapsedSeconds(125_000), '2m 5s');
});

test('applyReplayUpdate and TurnTraceRecorder preserve plan steps for session replay', () => {
	const buf = [];
	applyReplayUpdate(buf, {
		sessionUpdate: 'plan',
		entries: [
			{ content: 'Analyze notes', status: 'completed' },
			{ content: 'Write summary', status: 'in_progress' },
		],
	});
	assert.equal(buf.length, 1);
	assert.equal(buf[0].events[0].toolName, 'update_steps');
	assert.deepEqual(buf[0].events[0].toolArgs, {
		steps: [
			{ title: 'Analyze notes', status: 'done' },
			{ title: 'Write summary', status: 'in_progress' },
		],
	});

	const rec = new TurnTraceRecorder();
	rec.record({
		type: 'plan_update',
		steps: [{ title: 'Done step', status: 'done' }],
	});
	const [ev] = rec.snapshot();
	assert.equal(ev.type, 'tool');
	assert.equal(ev.toolName, 'update_steps');
	assert.deepEqual(ev.toolArgs, {
		steps: [{ title: 'Done step', status: 'done' }],
	});
});

test('AntigravityAcpClient routes update_steps, plan, and update_focus without polluting tool rows', async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-dian-plan-'));
	const fakeBin = path.join(tmpDir, 'fake-agy-plan.mjs');
	fs.writeFileSync(
		fakeBin,
		`#!/usr/bin/env node
import * as readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
rl.on('line', (line) => {
	const msg = JSON.parse(line);
	if (msg.method === 'initialize') {
		send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
		return;
	}
	if (msg.method === 'session/new') {
		send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-plan', models: { availableModels: [] } } });
		return;
	}
	if (msg.method === 'session/close') {
		send({ jsonrpc: '2.0', id: msg.id, result: {} });
		return;
	}
	if (msg.method === 'session/prompt') {
		send({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId: 'sess-plan',
				update: {
					sessionUpdate: 'tool_call',
					toolCallId: 'call_s1',
					name: 'update_steps',
					args: {
						steps: [
							{ title: 'Inspect vault', status: 'in_progress' },
							{ title: 'Write summary', status: 'pending' },
						],
					},
					status: 'in_progress',
				},
			},
		});
		send({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId: 'sess-plan',
				update: {
					sessionUpdate: 'tool_call_update',
					toolCallId: 'call_s1',
					name: 'update_steps',
					status: 'completed',
				},
			},
		});
		send({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId: 'sess-plan',
				update: {
					sessionUpdate: 'tool_call',
					toolCallId: 'call_f1',
					name: 'update_focus',
					args: { focus: 'Inspecting project notes' },
					status: 'in_progress',
				},
			},
		});
		send({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId: 'sess-plan',
				update: {
					sessionUpdate: 'plan',
					entries: [
						{ content: 'Inspect vault', status: 'completed' },
						{ content: 'Write summary', status: 'completed' },
					],
				},
			},
		});
		send({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId: 'sess-plan',
				update: {
					sessionUpdate: 'agent_message_chunk',
					content: { type: 'text', text: 'All done.' },
				},
			},
		});
		send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
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
	const plans = [];
	const focuses = [];
	const toolEvents = [];

	try {
		const res = await client.prompt('Do multi-step task', undefined, {
			onPlanUpdate: (steps) => plans.push(steps),
			onFocusUpdate: (focus) => focuses.push(focus),
			onToolStart: (name) => toolEvents.push(`start:${name}`),
			onToolEnd: (name) => toolEvents.push(`end:${name}`),
		});

		assert.equal(res.answer, 'All done.');
		assert.equal(plans.length, 2);
		assert.deepEqual(plans[0], [
			{ title: 'Inspect vault', status: 'in_progress' },
			{ title: 'Write summary', status: 'pending' },
		]);
		assert.deepEqual(plans[1], [
			{ title: 'Inspect vault', status: 'done' },
			{ title: 'Write summary', status: 'done' },
		]);
		assert.deepEqual(focuses, ['Inspecting project notes']);
		assert.deepEqual(toolEvents, []);
	} finally {
		await client.destroy();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('Agent forwards onPlanUpdate and onFocusUpdate as step events', async () => {
	const received = [];
	const fakeProvider = {
		getMcpToolServer: () => undefined,
		cancel() {},
		async resetSession() {},
		async runTurn(_prompt, _media, callbacks) {
			callbacks?.onPlanUpdate?.([{ title: 'Step A', status: 'in_progress' }]);
			callbacks?.onFocusUpdate?.('Working on Step A');
			return { answer: 'ok', stopReason: 'end_turn' };
		},
	};
	const agent = new Agent({ provider: fakeProvider });
	await agent.run('plan this', undefined, [], (evt) => received.push(evt));

	assert.ok(
		received.some(
			(e) =>
				e.type === 'plan_update' &&
				e.steps.length === 1 &&
				e.steps[0].title === 'Step A',
		),
	);
	assert.ok(
		received.some(
			(e) => e.type === 'focus_update' && e.focus === 'Working on Step A',
		),
	);
});

test('MCP update_focus tool emits focus_update in Agent without adding tool trace rows', async () => {
	const registry = new ToolRegistry().register(createUpdateFocusTool());
	const server = new McpToolServer(registry);
	const info = await server.start();
	const received = [];

	const callMcp = (name, args) =>
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
					res.on('end', () => resolve(JSON.parse(data)));
				},
			);
			req.on('error', reject);
			req.write(body);
			req.end();
		});

	const fakeProvider = {
		getMcpToolServer: () => server,
		cancel() {},
		async resetSession() {},
		async runTurn() {
			const reply = await callMcp('update_focus', {
				focus: 'Tìm các note liên quan',
			});
			assert.equal(reply.result.content[0].text, 'OK');
			return { answer: 'done', stopReason: 'end_turn' };
		},
	};

	try {
		const agent = new Agent({ provider: fakeProvider, tools: registry });
		await agent.run('so sánh 3 note', undefined, [], (evt) =>
			received.push(evt),
		);

		assert.ok(
			received.some(
				(e) =>
					e.type === 'focus_update' && e.focus === 'Tìm các note liên quan',
			),
		);
		assert.equal(
			received.some(
				(e) => e.type === 'tool_start' || e.type === 'tool_end',
			),
			false,
		);
	} finally {
		await server.stop();
	}
});
