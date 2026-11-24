import './ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ContextCompiler,
	stripCompiledContext,
} from '../src/core/context/compiler.ts';
import {
	appendReplayChunk,
	applyReplayUpdate,
	normalizeReplayedToolOutput,
	parseSessionList,
} from '../src/core/models/antigravity-acp.ts';
import {
	filterSessions,
	formatRelativeTime,
	groupSessionsByRecency,
} from '../src/obsidian/views/session-format.ts';

test('stripCompiledContext recovers the typed text from every compiled prompt shape', async () => {
	const compiler = new ContextCompiler({
		skillService: {
			async listSkills() {
				return [{ name: 'daily', description: 'Daily note helper' }];
			},
		},
		vaultService: {
			async getNoteOutline(path) {
				return { path, headings: [{ level: 1, heading: 'Intro' }], tags: ['#a'], backlinks: [] };
			},
		},
	});
	const first = await compiler.compile(
		'summarize\n\nthis please',
		{ activeFile: 'Notes/A.md', selection: 'line one\n\nline [two]\n]' },
		'plan',
	);
	assert.notEqual(first.prompt, 'summarize\n\nthis please');
	assert.equal(stripCompiledContext(first.prompt), 'summarize\n\nthis please');

	const second = await compiler.compile('next', { activeFile: 'Notes/B.md' });
	assert.equal(stripCompiledContext(second.prompt), 'next');

	assert.equal(stripCompiledContext('[Vault Skills: none configured]\n\nhi'), 'hi');
	assert.equal(stripCompiledContext('[not ours] keep'), '[not ours] keep');
	assert.equal(stripCompiledContext('plain'), 'plain');
});

test('ContextCompiler.resumeSession skips skill disclosure but re-sends the active note', async () => {
	let listed = 0;
	const compiler = new ContextCompiler({
		skillService: { async listSkills() { listed++; return []; } },
	});
	compiler.resumeSession();
	const out = await compiler.compile('hi', { activeFile: 'A.md' });
	assert.equal(listed, 0);
	assert.match(out.prompt, /Current Active Note/);
});

test('parseSessionList validates entries and keeps only the vault cwd', () => {
	const out = parseSessionList(
		[
			{ sessionId: 'a', cwd: '/vault', title: ' Greeting ', updatedAt: '2026-11-24T12:00:00Z' },
			{ sessionId: 'b', cwd: '/elsewhere', title: 'CLI work' },
			{ sessionId: '', cwd: '/vault' },
			null,
			{ sessionId: 'c', title: 42 },
		],
		'/vault',
	);
	assert.deepEqual(out, [
		{ sessionId: 'a', title: 'Greeting', updatedAt: '2026-11-24T12:00:00Z' },
		{ sessionId: 'c', title: undefined, updatedAt: undefined },
	]);
	assert.deepEqual(parseSessionList({ nope: true }, '/vault'), []);
});

test('appendReplayChunk merges consecutive chunks per role', () => {
	const buf = [];
	appendReplayChunk(buf, 'user', 'he');
	appendReplayChunk(buf, 'user', 'llo');
	appendReplayChunk(buf, 'agent', 'Hi');
	appendReplayChunk(buf, 'agent', '!');
	appendReplayChunk(buf, 'user', 'bye');
	assert.deepEqual(buf, [
		{ role: 'user', text: 'hello' },
		{ role: 'agent', text: 'Hi!', events: [] },
		{ role: 'user', text: 'bye' },
	]);
});

test('applyReplayUpdate keeps thoughts and tool calls in order within the agent turn', () => {
	const buf = [];
	const u = (update) => applyReplayUpdate(buf, update);
	u({ sessionUpdate: 'user_message_chunk', content: { text: 'list notes' } });
	u({ sessionUpdate: 'agent_thought_chunk', content: { text: 'Let me ' } });
	u({ sessionUpdate: 'agent_thought_chunk', content: { text: 'look.' } });
	u({
		sessionUpdate: 'tool_call',
		toolCallId: 't1',
		name: 'mcp_anti-dian-vault_list_notes',
		rawInput: { folder: 'A' },
		status: 'completed',
		rawOutput: { content: [{ type: 'text', text: '[{"path":"A/x.md"}]' }] },
	});
	u({ sessionUpdate: 'tool_call', toolCallId: 't2', name: 'run_command', args: { CommandLine: 'ls' }, status: 'pending' });
	u({ sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'failed', rawOutput: 'denied' });
	u({ sessionUpdate: 'agent_thought_chunk', content: { text: 'Done.' } });
	u({ sessionUpdate: 'agent_message_chunk', content: { text: 'One note.' } });
	u({ sessionUpdate: 'usage_update', used: 1, size: 2 });

	assert.deepEqual(buf, [
		{ role: 'user', text: 'list notes' },
		{
			role: 'agent',
			text: 'One note.',
			events: [
				{ type: 'thought', text: 'Let me look.' },
				{
					type: 'tool',
					callId: 't1',
					toolName: 'list_notes',
					toolArgs: { folder: 'A' },
					status: 'completed',
					output: [{ path: 'A/x.md' }],
				},
				{
					type: 'tool',
					callId: 't2',
					toolName: 'run_command',
					toolArgs: { CommandLine: 'ls' },
					status: 'failed',
					output: { error: 'denied' },
				},
				{ type: 'thought', text: 'Done.' },
			],
		},
	]);
});

test('normalizeReplayedToolOutput parses JSON text and flags failures', () => {
	assert.deepEqual(normalizeReplayedToolOutput('{"applied":true}', 'completed'), { applied: true });
	assert.equal(normalizeReplayedToolOutput('plain stdout', 'completed'), 'plain stdout');
	assert.deepEqual(normalizeReplayedToolOutput({ error: 'x' }, 'failed'), { error: 'x' });
	assert.deepEqual(normalizeReplayedToolOutput([{ type: 'text', text: 'oops' }], 'failed'), { error: 'oops' });
	assert.deepEqual(normalizeReplayedToolOutput(undefined, 'completed'), { status: 'completed' });
});

test('session picker helpers group, filter, and format recency', () => {
	const now = new Date(2026, 10, 24, 15, 0, 0).getTime();
	const iso = (d) => new Date(d).toISOString();
	const sessions = [
		{ sessionId: '1', title: 'Quantum book', updatedAt: iso(now - 5 * 60_000) },
		{ sessionId: '2', title: 'Greeting', updatedAt: iso(now - 20 * 3_600_000) },
		{ sessionId: '3', title: 'Old plan', updatedAt: iso(now - 3 * 86_400_000) },
		{ sessionId: '4' },
	];
	const groups = groupSessionsByRecency(sessions, now);
	assert.deepEqual(
		groups.map((g) => [g.label, g.sessions.map((s) => s.sessionId)]),
		[['Today', ['1']], ['Yesterday', ['2']], ['Previous 7 days', ['3']], ['Older', ['4']]],
	);
	assert.equal(formatRelativeTime(sessions[0].updatedAt, now), '5m');
	assert.equal(formatRelativeTime(sessions[2].updatedAt, now), '3d');
	assert.equal(formatRelativeTime(undefined, now), '');
	assert.deepEqual(filterSessions(sessions, 'QUANT bo').map((s) => s.sessionId), ['1']);
	assert.deepEqual(filterSessions(sessions, 'untitled').map((s) => s.sessionId), ['4']);
});
