import './ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ContextCompiler,
	extractForkedContext,
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
	searchSessions,
} from '../src/obsidian/views/session-format.ts';

test('stripCompiledContext recovers the typed text from every compiled prompt shape', async () => {
	const compiler = new ContextCompiler({
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

	// Sessions from before agy discovered skills start with a skill block.
	assert.equal(stripCompiledContext('[Vault Skills: none configured]\n\nhi'), 'hi');
	assert.equal(
		stripCompiledContext('[Available Vault Skills (call load_skill(name) when relevant):\n- daily: x\n]\n\nhi'),
		'hi',
	);
	assert.equal(stripCompiledContext('[not ours] keep'), '[not ours] keep');
	assert.equal(stripCompiledContext('plain'), 'plain');

	// Image-only prompt: nothing typed, and the CLI trims the trailing separator.
	const imageOnly = await compiler.compile('', { activeFile: 'Notes/C.md', selection: 'x' });
	assert.equal(stripCompiledContext(imageOnly.prompt.trim()), '');
	assert.equal(stripCompiledContext('[Vault Skills: none configured]'), '');
});

test('replay separates /compact from the next prompt but keeps text typed after it', () => {
	const chunk = (text) => ({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
	const buffer = [];
	for (const text of ['/compact', 'next']) applyReplayUpdate(buffer, chunk(text));
	assert.deepEqual(buffer.map((m) => [m.role, m.text]), [
		['user', '/compact'],
		['agent', 'Conversation compacted.'],
		['user', 'next'],
	]);

	const withArgs = [];
	for (const text of ['/compact', ' keep titles']) applyReplayUpdate(withArgs, chunk(text));
	assert.deepEqual(withArgs.map((m) => m.text), ['/compact keep titles']);
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

test('searchSessions ranks diacritic-insensitive, acronym, typo and fuzzy matches', () => {
	const sessions = [
		{ sessionId: 'a', title: 'Antigravity Harness Usage' },
		{ sessionId: 'b', title: 'Cập Nhật UI Antigravity cho sidebar' },
		{ sessionId: 'c', title: 'AI Thinking And Tool Usage' },
		{ sessionId: 'd', title: 'Review Repo Documentation' },
		{ sessionId: 'e', title: 'Casual Greeting' },
		{ sessionId: 'f', title: 'Đề cương điện toán lượng tử' },
	];
	const ids = (q) => searchSessions(sessions, q).map((h) => h.session.sessionId);

	// Diacritics and đ fold away; highlight ranges point into the original title.
	assert.deepEqual(ids('cap nhat'), ['b']);
	assert.deepEqual(ids('dien toan'), ['f']);
	const [hit] = searchSessions(sessions, 'nhat');
	assert.equal('Cập Nhật UI Antigravity cho sidebar'.slice(...hit.ranges[0]), 'Nhật');

	// Title starting with the word ranks above a mid-title match.
	assert.deepEqual(ids('antigravity'), ['a', 'b']);
	// Word initials.
	assert.equal(ids('tatu')[0], 'c');
	// Typos.
	assert.deepEqual(ids('antigravty'), ['a', 'b']);
	assert.deepEqual(ids('reveiw'), ['d']);
	// Compact subsequence.
	assert.deepEqual(ids('grtng'), ['e']);
	// Every term must match; empty query keeps everything in order.
	assert.deepEqual(ids('review greeting'), []);
	assert.equal(ids('  ').length, sessions.length);
	// Phrase match outranks scattered terms.
	assert.equal(ids('tool usage')[0], 'c');
});

const traceMod = await import('../src/core/sessions/trace.ts');
const {
	TurnTraceRecorder,
	compactTraceValue,
	mergeStoredTraces,
	storedTurnsToReplayedMessages,
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

const transcriptMod = await import('../src/core/sessions/transcript.ts');
const {
	getAgyTranscriptPaths,
	loadAgyTranscriptTurns,
	parseAgyTranscriptJsonl,
} = transcriptMod;

test('parseAgyTranscriptJsonl extracts turns, tool calls, outputs, durations, and usage', () => {
	const jsonl = [
		JSON.stringify({
			step_index: 0,
			type: 'USER_INPUT',
			status: 'DONE',
			created_at: '2026-11-24T12:40:46Z',
			content:
				'<USER_REQUEST>\n[Vault Skills: none configured]\n\n[Current Active Note: [[a]] (path: a.md)]\n\nsummarize note\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>',
		}),
		JSON.stringify({
			step_index: 1,
			type: 'PLANNER_RESPONSE',
			status: 'DONE',
			created_at: '2026-11-24T12:40:47Z',
			input_tokens: 1000,
			cache_read_tokens: 500,
			output_tokens: 50,
			tool_calls: [
				{
					name: 'mcp_anti-dian-vault_read_note',
					args: { path: '"a.md"', toolSummary: '"Read a"' },
				},
			],
		}),
		JSON.stringify({
			step_index: 2,
			type: 'GENERIC',
			status: 'DONE',
			created_at: '2026-11-24T12:40:48Z',
			content:
				'Created At: 2026-11-24T12:40:48Z\nCompleted At: 2026-11-24T12:40:49Z\n{"path":"a.md","content":"hello"}',
		}),
		JSON.stringify({
			step_index: 3,
			type: 'PLANNER_RESPONSE',
			status: 'DONE',
			created_at: '2026-11-24T12:40:51Z',
			input_tokens: 200,
			cache_read_tokens: 1200,
			output_tokens: 120,
			content: 'Summary text',
		}),
		'not valid json',
	].join('\n');

	const turns = parseAgyTranscriptJsonl(jsonl);
	assert.equal(turns.length, 1);
	const [turn] = turns;
	assert.equal(turn.userText, 'summarize note');
	assert.equal(turn.durationMs, 5000);
	assert.deepEqual(turn.usage, {
		promptTokens: 2900,
		candidatesTokens: 170,
		totalTokens: 3070,
		cachedReadTokens: 1700,
		cachedWriteTokens: 0,
		thoughtTokens: 0,
	});
	assert.equal(turn.events.length, 1);
	assert.equal(turn.events[0].type, 'tool');
	assert.equal(turn.events[0].toolName, 'read_note');
	assert.deepEqual(turn.events[0].toolArgs, { path: 'a.md' });
	assert.equal(turn.events[0].status, 'completed');
	assert.deepEqual(turn.events[0].output, { path: 'a.md', content: 'hello' });
});

test('parseAgyTranscriptJsonl reconstructs _diff for replace_block edits', () => {
	const jsonl = [
		JSON.stringify({
			step_index: 0,
			type: 'USER_INPUT',
			created_at: '2026-11-24T12:40:46Z',
			content: '<USER_REQUEST>\nrename header\n</USER_REQUEST>',
		}),
		JSON.stringify({
			step_index: 1,
			type: 'PLANNER_RESPONSE',
			created_at: '2026-11-24T12:40:47Z',
			tool_calls: [
				{
					name: 'mcp_anti-dian-vault_replace_block',
					args: {
						path: '"note.md"',
						oldText: '"# Old Title"',
						newText: '"# New Title"',
					},
				},
			],
		}),
		JSON.stringify({
			step_index: 2,
			type: 'GENERIC',
			status: 'DONE',
			created_at: '2026-11-24T12:40:48Z',
			content:
				'Created At: 2026-11-24T12:40:48Z\nCompleted At: 2026-11-24T12:40:49Z\n{"staged":false,"applied":true,"message":"Applied"}',
		}),
	].join('\n');

	const turns = parseAgyTranscriptJsonl(jsonl);
	assert.equal(turns.length, 1);
	const tool = turns[0].events[0];
	assert.equal(tool.toolName, 'replace_block');
	assert.equal(tool.output.applied, true);
	assert.ok(tool.output._diff);
	assert.equal(tool.output._diff.additions, 1);
	assert.equal(tool.output._diff.deletions, 1);
	assert.equal(tool.output._diff.hunks.length, 1);
});

test('getAgyTranscriptPaths rejects path traversal and loadAgyTranscriptTurns reads from disk', async () => {
	assert.deepEqual(getAgyTranscriptPaths('../evil'), []);

	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-dian-tr-'));
	try {
		const logsDir = path.join(
			tmpHome,
			'.gemini',
			'antigravity-anti-dian',
			'brain',
			'sess-123',
			'.system_generated',
			'logs',
		);
		fs.mkdirSync(logsDir, { recursive: true });
		fs.writeFileSync(
			path.join(logsDir, 'transcript_full.jsonl'),
			JSON.stringify({
				type: 'USER_INPUT',
				created_at: '2026-11-24T12:00:00Z',
				content: '<USER_REQUEST>\nhi\n</USER_REQUEST>',
			}) +
				'\n' +
				JSON.stringify({
					type: 'PLANNER_RESPONSE',
					created_at: '2026-11-24T12:00:02Z',
					input_tokens: 10,
					output_tokens: 5,
					content: 'hello',
				}),
		);
		const turns = await loadAgyTranscriptTurns(
			'sess-123',
			'antigravity-anti-dian',
			tmpHome,
		);
		assert.equal(turns.length, 1);
		assert.equal(turns[0].userText, 'hi');
		assert.equal(turns[0].durationMs, 2000);

		// Spilled output.txt inside brain/<sessionId>/.system_generated/steps/ is loaded cleanly
		const stepDir = path.join(
			tmpHome,
			'.gemini',
			'antigravity-anti-dian',
			'brain',
			'sess-456',
			'.system_generated',
			'steps',
			'4',
		);
		const logs456 = path.join(
			tmpHome,
			'.gemini',
			'antigravity-anti-dian',
			'brain',
			'sess-456',
			'.system_generated',
			'logs',
		);
		fs.mkdirSync(stepDir, { recursive: true });
		fs.mkdirSync(logs456, { recursive: true });
		const bigNote = 'line\n'.repeat(1200);
		const spilledPath = path.join(stepDir, 'output.txt');
		fs.writeFileSync(
			spilledPath,
			`Created At: 2026-11-24T12:00:01Z\nCompleted At: 2026-11-24T12:00:02Z\n${JSON.stringify({ path: 'big.md', content: bigNote })}`,
		);
		const { pathToFileURL } = await import('node:url');
		fs.writeFileSync(
			path.join(logs456, 'transcript.jsonl'),
			[
				JSON.stringify({
					type: 'USER_INPUT',
					created_at: '2026-11-24T12:00:00Z',
					content: '<USER_REQUEST>\nread big\n</USER_REQUEST>',
				}),
				JSON.stringify({
					type: 'PLANNER_RESPONSE',
					created_at: '2026-11-24T12:00:01Z',
					tool_calls: [{ name: 'mcp_anti-dian-vault_read_note', args: { path: '"big.md"' } }],
				}),
				JSON.stringify({
					type: 'GENERIC',
					status: 'DONE',
					created_at: '2026-11-24T12:00:01Z',
					content: `Created At: 2026-11-24T12:00:01Z\nCompleted At: 2026-11-24T12:00:02Z\nThe tool's output was truncated due to being too long. You can find the full output in a file at ${pathToFileURL(spilledPath).href}.\n\nHere is a preview with the middle of the output truncated:\n{"path":"big.md","content":"broken...`,
				}),
			].join('\n'),
		);
		const spilledTurns = await loadAgyTranscriptTurns(
			'sess-456',
			'antigravity-anti-dian',
			tmpHome,
		);
		assert.equal(spilledTurns.length, 1);
		const readTool = spilledTurns[0].events[0];
		assert.equal(readTool.output.path, 'big.md');
		assert.deepEqual(originalTextSize(readTool.output, 'content'), {
			chars: bigNote.length,
			lines: 1201,
		});
	} finally {
		fs.rmSync(tmpHome, { recursive: true, force: true });
	}
});

test('ContextCompiler.seedForkedHistory injects parent turns once and strips cleanly on replay', async () => {
	const compiler = new ContextCompiler();
	compiler.seedForkedHistory([
		{
			userText: 'summarize [[Note A]]',
			agentText: 'Summary with [brackets]\n]\nand code.',
		},
	]);

	const first = await compiler.compile('now expand section 2');
	assert.match(first.prompt, /^\[Forked Conversation Context:/);
	assert.match(first.prompt, /User: summarize \[\[Note A\]\]/);
	assert.match(first.prompt, /Assistant: Summary with \[brackets\]/);
	assert.equal(stripCompiledContext(first.prompt), 'now expand section 2');

	const second = await compiler.compile('follow up');
	assert.equal(second.prompt, 'follow up');
});

test('buildSessionTree nests forked children under parents and formats (fork) titles', async () => {
	const { buildSessionTree } = await import(
		'../src/obsidian/views/session-format.ts'
	);
	const sessions = [
		{ sessionId: 'c1', title: 'Reusable UI components from Obsidian', updatedAt: '2026-11-24T12:05:00Z' },
		{ sessionId: 'p1', title: 'Reusable UI components from Obsidian', updatedAt: '2026-11-24T12:00:00Z' },
		{ sessionId: 'p2', title: 'Antigravity CLI login requirement', updatedAt: '2026-11-24T11:00:00Z' },
		{ sessionId: 'orphan', title: 'Orphan branch', updatedAt: '2026-11-24T10:00:00Z' },
	];
	const forks = {
		c1: { parentId: 'p1', title: 'Reusable UI components from Obsidian (fork)' },
		orphan: { parentId: 'deleted-parent', title: 'Orphan branch (fork)' },
	};

	const tree = buildSessionTree(sessions, forks);
	assert.equal(tree.length, 3);
	assert.equal(tree[0].session.sessionId, 'p1');
	assert.equal(tree[0].children.length, 1);
	assert.equal(tree[0].children[0].session.sessionId, 'c1');
	assert.equal(
		tree[0].children[0].displayTitle,
		'Reusable UI components from Obsidian (fork)',
	);
	assert.equal(tree[1].session.sessionId, 'p2');
	assert.equal(tree[2].session.sessionId, 'orphan');
	assert.equal(tree[2].displayTitle, 'Orphan branch (fork)');
});

test('extractForkedContext and parseAgyTranscriptJsonl recover parent turns for forked sessions', async () => {
	const {
		forkedTurnsToReplayedMessages,
		parseAgyTranscriptJsonl,
	} = await import('../src/core/sessions/transcript.ts');

	const compiler = new ContextCompiler();
	compiler.seedForkedHistory([
		{ userText: 'first question', agentText: 'first answer\n\nwith details' },
		{ userText: 'second question', agentText: 'second answer' },
	]);
	const compiled = await compiler.compile('child follow-up');

	const extracted = extractForkedContext(compiled.prompt);
	assert.deepEqual(extracted, [
		{ userText: 'first question', agentText: 'first answer\n\nwith details' },
		{ userText: 'second question', agentText: 'second answer' },
	]);

	const childJsonl = [
		JSON.stringify({
			type: 'USER_INPUT',
			created_at: '2026-11-24T12:10:00Z',
			content: `<USER_REQUEST>\n${compiled.prompt}\n</USER_REQUEST>`,
		}),
		JSON.stringify({
			type: 'PLANNER_RESPONSE',
			created_at: '2026-11-24T12:10:03Z',
			content: 'child answer',
		}),
	].join('\n');

	const parsed = parseAgyTranscriptJsonl(childJsonl);
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].userText, 'child follow-up');
	assert.equal(parsed[0].agentText, 'child answer');
	assert.deepEqual(parsed[0].forkedContext, extracted);

	const fallbackMessages = forkedTurnsToReplayedMessages(parsed[0].forkedContext);
	assert.equal(fallbackMessages.length, 4);
	assert.equal(fallbackMessages[0].role, 'user');
	assert.equal(fallbackMessages[1].text, 'first answer\n\nwith details');

	const replayed = storedTurnsToReplayedMessages(parsed);
	assert.equal(replayed.length, 2);
	assert.equal(replayed[0].text, 'child follow-up');
	assert.equal(replayed[1].text, 'child answer');
});

test('custom session titles override default/fork titles and deleteAgySessionData cleans up safely', async () => {
	const { buildSessionTree } = await import(
		'../src/obsidian/views/session-format.ts'
	);
	const { deleteAgySessionData } = await import(
		'../src/core/sessions/transcript.ts'
	);

	const sessions = [
		{ sessionId: 'c1', title: 'Parent', updatedAt: '2026-11-24T12:05:00Z' },
		{ sessionId: 'p1', title: 'Parent', updatedAt: '2026-11-24T12:00:00Z' },
	];
	const tree = buildSessionTree(
		sessions,
		{ c1: { parentId: 'p1' } },
		{ p1: 'Custom Parent', c1: 'Renamed Branch' },
	);
	assert.equal(tree[0].displayTitle, 'Custom Parent');
	assert.equal(tree[0].children[0].displayTitle, 'Renamed Branch');

	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-dian-del-'));
	try {
		const base = path.join(tmpHome, '.gemini', 'antigravity-anti-dian');
		const brainDir = path.join(base, 'brain', 'sess-del-1');
		const convDir = path.join(base, 'conversations');
		fs.mkdirSync(brainDir, { recursive: true });
		fs.mkdirSync(convDir, { recursive: true });
		fs.writeFileSync(path.join(brainDir, 'file.txt'), 'x');
		fs.writeFileSync(path.join(convDir, 'sess-del-1.db'), 'db');
		fs.writeFileSync(path.join(convDir, 'keep.db'), 'keep');

		// Path traversal must be ignored
		await deleteAgySessionData('../evil', 'antigravity-anti-dian', tmpHome);
		assert.equal(fs.existsSync(path.join(convDir, 'keep.db')), true);

		await deleteAgySessionData('sess-del-1', 'antigravity-anti-dian', tmpHome);
		assert.equal(fs.existsSync(brainDir), false);
		assert.equal(fs.existsSync(path.join(convDir, 'sess-del-1.db')), false);
		assert.equal(fs.existsSync(path.join(convDir, 'keep.db')), true);
	} finally {
		fs.rmSync(tmpHome, { recursive: true, force: true });
	}
});

test('image-only turns keep their own user message when a session is reopened', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-dian-media-'));
	try {
		const brain = path.join(tmpHome, '.gemini', 'antigravity-anti-dian', 'brain', 'sess-img');
		const logs = path.join(brain, '.system_generated', 'logs');
		const uploads = path.join(brain, '.user_uploaded');
		fs.mkdirSync(logs, { recursive: true });
		fs.mkdirSync(uploads, { recursive: true });
		const image = path.join(uploads, 'a.jpg');
		fs.writeFileSync(image, 'img');
		const outside = path.join(brain, 'secret.png');
		fs.writeFileSync(outside, 'secret');

		const user = (text, media) => ({
			type: 'USER_INPUT',
			created_at: '2026-11-25T03:28:21Z',
			content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>`,
			media,
		});
		const agent = (content, thinking) => ({
			type: 'PLANNER_RESPONSE',
			created_at: '2026-11-25T03:28:27Z',
			content,
			thinking,
		});
		const jpg = (uri) => ({ mime_type: 'image/jpeg', uri });
		fs.writeFileSync(
			path.join(logs, 'transcript_full.jsonl'),
			[
				user('[Vault Skills: none configured]', [jpg(image)]),
				agent('zero'),
				user('what is this'),
				agent('one', 'think one'),
				user('', [jpg(image)]),
				agent('two', 'think two\n\n'),
				user('', [jpg(path.join(uploads, 'gone.jpg')), jpg(outside), { mime_type: 'text/html', uri: image }]),
				user('with text', [jpg(image)]),
				agent('three'),
			]
				.map((step) => JSON.stringify(step))
				.join('\n'),
		);
		const stored = await loadAgyTranscriptTurns('sess-img', 'antigravity-anti-dian', tmpHome);
		assert.equal(stored.length, 5);

		const loaded = { type: 'image', mimeType: 'image/jpeg', uri: image, data: 'data:image/jpeg;base64,aW1n' };
		// What the CLI replays: image-only user messages missing, answers glued together.
		const replayed = [
			{ role: 'agent', text: 'zero', events: [] },
			{ role: 'user', text: 'what is this' },
			{ role: 'agent', text: 'one\n\ntwo', events: [{ type: 'thought', text: 'think onethink two' }] },
			{ role: 'user', text: 'with text' },
			{ role: 'agent', text: 'three', events: [] },
		];
		const merged = mergeStoredTraces(replayed, stored);
		assert.deepEqual(
			merged.map((m) => [m.role, m.text]),
			[
				['user', ''],
				['agent', 'zero'],
				['user', 'what is this'],
				['agent', 'one'],
				['user', ''],
				['agent', 'two'],
				['user', ''],
				['user', 'with text'],
				['agent', 'three'],
			],
		);
		assert.deepEqual(merged[0].media, [loaded]);
		assert.equal(merged[2].media, undefined);
		assert.deepEqual(merged[3].events, [{ type: 'thought', text: 'think one' }]);
		assert.deepEqual(merged[4].media, [loaded]);
		assert.deepEqual(merged[5].events, [{ type: 'thought', text: 'think two' }]);
		// Missing files and paths outside .user_uploaded are never read; non-images are dropped.
		assert.deepEqual(merged[6].media.map((m) => m.data), [undefined, undefined]);
		assert.deepEqual(merged[7].media, [loaded]);

		assert.equal(storedTurnsToReplayedMessages(stored).filter((m) => m.role === 'user').length, 5);
		assert.deepEqual(mergeStoredTraces([], stored), []);
	} finally {
		fs.rmSync(tmpHome, { recursive: true, force: true });
	}
});
