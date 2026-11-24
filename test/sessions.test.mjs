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
	assert.equal(normalizeReplayedToolOutput(undefined, 'completed'), undefined);
	assert.deepEqual(normalizeReplayedToolOutput(undefined, 'failed'), { error: 'Tool call failed' });
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

const traceMod = await import('../src/core/sessions/trace.ts');
const {
	TurnTraceRecorder,
	compactTraceValue,
	mergeStoredTraces,
	originalTextSize,
	parseStoredTurns,
	TRACE_MAX_STRING_CHARS,
} = traceMod;

test('TurnTraceRecorder pairs tool events and compacts large results', () => {
	const rec = new TurnTraceRecorder();
	const big = 'x\n'.repeat(TRACE_MAX_STRING_CHARS);
	rec.record({ type: 'thinking' });
	rec.record({ type: 'thought_delta', text: 'Read ' });
	rec.record({ type: 'thought_delta', text: 'it.' });
	rec.record({ type: 'tool_start', toolName: 'read_note', toolArgs: { path: 'A.md' }, callId: 'c1' });
	rec.record({ type: 'tool_start', toolName: 'search_notes', toolArgs: { query: 'q' } });
	rec.record({ type: 'tool_end', toolName: 'search_notes', toolOutput: { error: 'boom' } });
	rec.record({ type: 'tool_end', toolName: 'read_note', toolOutput: { path: 'A.md', content: big }, callId: 'c1' });
	rec.record({ type: 'answer_delta', text: 'ignored' });

	const [thought, read, search] = rec.snapshot();
	assert.deepEqual(thought, { type: 'thought', text: 'Read it.' });
	assert.equal(read.status, 'completed');
	assert.equal(read.output.content.length, TRACE_MAX_STRING_CHARS + 1);
	assert.deepEqual(originalTextSize(read.output, 'content'), { chars: big.length, lines: TRACE_MAX_STRING_CHARS + 1 });
	assert.equal(search.status, 'failed');
	assert.deepEqual(search.output, { error: 'boom' });
	assert.deepEqual(compactTraceValue({ a: 'short' }), { a: 'short' });
});

test('mergeStoredTraces overlays saved traces by typed text and keeps the rest', () => {
	const replayed = [
		{ role: 'user', text: 'hi' },
		{ role: 'agent', text: 'Hello', events: [] },
		{ role: 'user', text: 'summarize' },
		{ role: 'agent', text: 'Summary', events: [{ type: 'tool', toolName: 'read_note', toolArgs: {}, status: 'completed' }] },
		{ role: 'user', text: 'unsaved turn' },
		{ role: 'agent', text: 'ok', events: [{ type: 'thought', text: 'cli thought' }] },
	];
	const usage = { promptTokens: 1, candidatesTokens: 2, totalTokens: 3, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 1 };
	const stored = [
		{ userText: 'summarize', events: [{ type: 'thought', text: 'saved thought' }, { type: 'tool', toolName: 'read_note', toolArgs: {}, status: 'completed', output: { content: 'c' } }], durationMs: 1900, usage, savedAt: '' },
	];
	const merged = mergeStoredTraces(replayed, stored);
	assert.equal(merged[1].events.length, 0);
	assert.equal(merged[3].events[0].text, 'saved thought');
	assert.equal(merged[3].durationMs, 1900);
	assert.deepEqual(merged[3].usage, usage);
	assert.equal(merged[3].text, 'Summary');
	assert.equal(merged[5].events[0].text, 'cli thought');
	assert.equal(replayed[3].events.length, 1, 'input is not mutated');
});

test('parseStoredTurns drops malformed entries', () => {
	const turns = parseStoredTurns({
		version: 1,
		turns: [
			{ userText: 'a', events: [{ type: 'thought', text: 't' }, { type: 'tool' }, 5], durationMs: 'x', savedAt: 'now' },
			{ events: [] },
			null,
		],
	});
	assert.deepEqual(turns, [
		{ userText: 'a', events: [{ type: 'thought', text: 't' }], durationMs: undefined, usage: undefined, cancelled: undefined, savedAt: 'now' },
	]);
	assert.deepEqual(parseStoredTurns('garbage'), []);
});
