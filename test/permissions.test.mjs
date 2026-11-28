import './ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isSkillFilePath } from '../src/core/skills/index.ts';
import { AntigravityAcpClient } from '../src/core/models/antigravity-acp.ts';
import { Agent } from '../src/core/agent/index.ts';
import {
	blockedContinuePrompt,
	blockedToolsReply,
	classifyToolPermission,
	describeBlockedTools,
	isVaultMcpServer,
	readFileRoots,
	toAbsolutePath,
} from '../src/core/models/tool-permissions.ts';

test('isSkillFilePath accepts files inside a skill folder under a skill root', () => {
	const roots = ['/v/.agents/skills', 'C:\\v\\.agents\\skills\\'];
	assert.equal(isSkillFilePath('/v/.agents/skills/json-canvas/SKILL.md', roots), true);
	assert.equal(isSkillFilePath('/v/.agents/skills/json-canvas/references/spec.md', roots), true);
	assert.equal(isSkillFilePath('C:\\v\\.agents\\skills\\daily\\SKILL.md', roots), true);
});

test('isSkillFilePath rejects paths outside skill folders', () => {
	const roots = ['/v/.agents/skills'];
	assert.equal(isSkillFilePath('/v/note.md', roots), false);
	assert.equal(isSkillFilePath('/v/.agents/skills/README.md', roots), false);
	assert.equal(isSkillFilePath('/v/.agents/skills-other/x/SKILL.md', roots), false);
	assert.equal(isSkillFilePath('/v/.agents/skills/x/../../note.md', roots), false);
	assert.equal(isSkillFilePath('.agents/skills/x/SKILL.md', roots), false);
	assert.equal(isSkillFilePath('/v/.agents/skills/x//SKILL.md', roots), false);
	assert.equal(isSkillFilePath(undefined, roots), false);
});

test('isSkillFilePath accepts file:// URIs, as agy names offloaded outputs', () => {
	const roots = ['/v/.agents/skills'];
	assert.equal(isSkillFilePath('file:///v/.agents/skills/x/SKILL.md', roots), true);
	assert.equal(isSkillFilePath('file:///v/.agents/skills/x%20y/SKILL.md', roots), true);
	assert.equal(isSkillFilePath('file:///v/note.md', roots), false);
});

test('toAbsolutePath normalizes paths and file URIs, and refuses relative or unsafe ones', () => {
	assert.equal(toAbsolutePath('/a/b/'), '/a/b');
	assert.equal(toAbsolutePath('file:///a/b%20c.md'), '/a/b c.md');
	assert.equal(toAbsolutePath('file:///C:/v/x.md'), 'C:/v/x.md');
	assert.equal(toAbsolutePath('C:\\v\\x.md'), 'C:/v/x.md');
	assert.equal(toAbsolutePath('notes/x.md'), null);
	assert.equal(toAbsolutePath('/a/../b'), null);
	assert.equal(toAbsolutePath('/a/./b'), null);
	assert.equal(toAbsolutePath('file:///a/%E0%A4%A'), null);
	assert.equal(toAbsolutePath(42), null);
});

test('readFileRoots lists only the skill folders, agy MCP tool schemas, and current session offloaded outputs', () => {
	const roots = readFileRoots('/vault', 'antigravity-anti-dian', '/home/u', 'sess-1');
	assert.deepEqual(roots, [
		'/vault/.agents/skills',
		'/home/u/.agents/skills',
		'/home/u/.gemini/config/skills',
		'/home/u/.gemini/antigravity-anti-dian/mcp',
		'/home/u/.gemini/antigravity-anti-dian/brain/sess-1/.system_generated',
	]);
	assert.equal(isSkillFilePath('/home/u/.gemini/antigravity-anti-dian/mcp/excalidraw/addRect.json', roots), true);
	assert.equal(
		isSkillFilePath('/home/u/.gemini/antigravity-anti-dian/brain/sess-1/.system_generated/steps/49/output.txt', roots),
		true,
	);
	assert.equal(isSkillFilePath('/home/u/.gemini/antigravity-anti-dian/brain/x.md', roots), false);
	assert.equal(
		isSkillFilePath('/home/u/.gemini/antigravity-anti-dian/brain/sess-2/.system_generated/steps/1/output.txt', roots),
		false,
	);
	assert.equal(isSkillFilePath('/home/u/.gemini/config/skills/gemini-frontend/SKILL.md', roots), true);
	assert.equal(readFileRoots('/vault', 'antigravity-anti-dian', '/home/u', '../evil').length, 4);
});

test('isVaultMcpServer recognizes only the vault MCP server', () => {
	assert.equal(isVaultMcpServer({ ServerName: 'antidian-vault', ToolName: 'read_note' }), true);
	assert.equal(isVaultMcpServer({ ServerName: 'excalidraw' }), false);
	assert.equal(isVaultMcpServer(undefined), false);
});

test('blockedToolsReply names refused tools, or nothing when none were refused', () => {
	assert.equal(blockedToolsReply([]), undefined);
	assert.equal(blockedToolsReply(undefined), undefined);
	assert.match(
		blockedToolsReply([
			{ name: 'read_file', reason: 'vault' },
			{ name: 'view_file', reason: 'vault' },
		]),
		/^Stopped: Antidian blocked `read_file`, `view_file`: built-in file tools cannot open vault files/,
	);
});

test('describeBlockedTools explains each reason once, and the Continue prompt avoids the refused tools', () => {
	const blocked = [
		{ name: 'run_command', reason: 'shell' },
		{ name: 'list_dir', reason: 'user' },
		{ name: 'write_to_file', reason: 'write' },
	];
	const text = describeBlockedTools(blocked);
	assert.match(text, /`run_command`: shell commands are not available/);
	assert.match(text, /You denied `list_dir`\./);
	assert.match(text, /`write_to_file`: built-in tools cannot write files/);
	assert.match(text, /agy ends the turn when a tool is refused\.$/);
	assert.equal(describeBlockedTools([]), undefined);

	const prompt = blockedContinuePrompt(blocked);
	assert.match(prompt, /^Continue the previous request without `run_command`, `list_dir`, `write_to_file`\./);
	assert.match(prompt, /antidian-vault tools/);
	assert.match(prompt, /Shell commands are not available/);
	assert.equal(
		blockedContinuePrompt([{ name: 'list_dir', reason: 'user' }]),
		'Continue the previous request without `list_dir`.',
	);
});

test('classifyToolPermission allows vault, MCP, safe built-ins, and reads inside the read roots', () => {
	const ctx = {
		vaultPath: '/home/u/Vault',
		readRoots: readFileRoots('/home/u/Vault', 'antigravity-antidian', '/home/u', 'sess-1'),
		planMode: false,
		mcpServerNames: ['excalidraw'],
	};
	const allow = { kind: 'allow' };
	assert.deepEqual(classifyToolPermission('mcp_antidian-vault_read_note', { path: 'a.md' }, ctx), allow);
	assert.deepEqual(classifyToolPermission('mcp_anti-dian-vault_read_note', {}, ctx), allow);
	assert.deepEqual(classifyToolPermission('mcp_excalidraw_create_elements', {}, ctx), allow);
	assert.deepEqual(classifyToolPermission('mcp_rea_open_binary', {}, ctx), allow);
	assert.deepEqual(classifyToolPermission('call_mcp_tool', { ServerName: 'rea', ToolName: 'x' }, ctx), allow);
	assert.deepEqual(classifyToolPermission('search_web', { query: 'x' }, ctx), allow);
	assert.deepEqual(classifyToolPermission('read_url_content', { Url: 'https://example.com' }, ctx), allow);
	assert.deepEqual(
		classifyToolPermission('read_file', { Path: '/home/u/.gemini/config/skills/gemini-frontend/SKILL.md' }, ctx),
		allow,
	);
	assert.deepEqual(
		classifyToolPermission(
			'read_file',
			{ Path: 'file:///home/u/.gemini/antigravity-antidian/brain/sess-1/.system_generated/steps/5/output.txt' },
			ctx,
		),
		allow,
	);
	assert.deepEqual(classifyToolPermission('read_file', { Path: '/home/u/Vault/.agents/skills/daily/SKILL.md' }, ctx), allow);
	assert.deepEqual(classifyToolPermission('list_dir', { DirectoryPath: '/home/u/.gemini/config/skills' }, ctx), allow);
	assert.deepEqual(
		classifyToolPermission('grep_search', { SearchPath: '/home/u/.agents/skills/x/references', Query: 'y' }, ctx),
		allow,
	);
});

test('classifyToolPermission refuses vault file access, file writes, and shell commands', () => {
	const ctx = {
		vaultPath: '/home/u/Vault',
		readRoots: readFileRoots('/home/u/Vault', 'antigravity-antidian', '/home/u', 'sess-1'),
		planMode: false,
	};
	const deny = (reason) => ({ kind: 'deny', reason });
	assert.deepEqual(classifyToolPermission('read_file', { Path: '/home/u/Vault/Home.md' }, ctx), deny('vault'));
	assert.deepEqual(classifyToolPermission('read_file', { Path: '/home/u/vault/Home.md' }, ctx), deny('vault'));
	assert.deepEqual(classifyToolPermission('read_file', { Path: 'Home.md' }, ctx), deny('vault'));
	assert.deepEqual(classifyToolPermission('read_file', { Path: '/home/u/Vault/../x' }, ctx), deny('vault'));
	assert.deepEqual(classifyToolPermission('list_dir', { DirectoryPath: '/home/u/Vault' }, ctx), deny('vault'));
	assert.deepEqual(classifyToolPermission('view_code_item', { File: '/x', Path: '/home/u/Vault/a.md' }, ctx), deny('vault'));
	assert.deepEqual(classifyToolPermission('write_to_file', { TargetFile: '/tmp/x' }, ctx), deny('write'));
	assert.deepEqual(classifyToolPermission('replace_file_content', {}, ctx), deny('write'));
	assert.deepEqual(classifyToolPermission('run_command', { CommandLine: 'ls' }, ctx), deny('shell'));
});

test('classifyToolPermission asks about reads elsewhere, other built-ins, and MCP tools in Plan mode', () => {
	const ctx = {
		vaultPath: '/home/u/Vault',
		readRoots: readFileRoots('/home/u/Vault', 'antigravity-antidian', '/home/u', 'sess-1'),
		planMode: false,
	};
	assert.deepEqual(classifyToolPermission('read_file', { Path: '/home/u/Downloads/a.pdf' }, ctx), {
		kind: 'ask',
		sessionKey: 'read_file:/home/u/Downloads',
		sessionScope: 'read_file in /home/u/Downloads for this session',
		target: '/home/u/Downloads/a.pdf',
	});
	assert.deepEqual(classifyToolPermission('list_dir', { DirectoryPath: '/home/u/Downloads' }, ctx), {
		kind: 'ask',
		sessionKey: 'list_dir:/home/u/Downloads',
		sessionScope: 'list_dir in /home/u/Downloads for this session',
		target: '/home/u/Downloads',
	});
	assert.deepEqual(
		classifyToolPermission('read_file', { Path: '/home/u/.gemini/antigravity-antidian/brain/sess-2/.system_generated/steps/1/output.txt' }, ctx).kind,
		'ask',
	);
	assert.deepEqual(classifyToolPermission('generate_image', { Prompt: 'a cat' }, ctx), {
		kind: 'ask',
		sessionKey: 'tool:generate_image',
		sessionScope: 'generate_image for this session',
		target: undefined,
	});
	assert.equal(classifyToolPermission('read_file', {}, ctx).kind, 'ask');

	const plan = { ...ctx, planMode: true, mcpServerNames: ['excalidraw'] };
	assert.deepEqual(classifyToolPermission('mcp_excalidraw_create_elements', {}, plan), {
		kind: 'ask',
		sessionKey: 'mcp:excalidraw/create_elements',
		sessionScope: 'excalidraw/create_elements for this session',
		target: 'excalidraw/create_elements',
	});
	assert.equal(classifyToolPermission('call_mcp_tool', { ServerName: 'rea', ToolName: 'x' }, plan).kind, 'ask');
	assert.deepEqual(classifyToolPermission('call_mcp_tool', { ServerName: 'antidian-vault', ToolName: 'edit_note' }, plan), { kind: 'allow' });
	assert.deepEqual(classifyToolPermission('mcp_antidian-vault_edit_note', {}, plan), { kind: 'allow' });
});

test('AntigravityAcpClient allows skill reads, refuses unanswerable requests, and reports them', async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antidian-perm-'));
	const fakeBin = path.join(tmpDir, 'fake-agy.mjs');
	const outFile = path.join(tmpDir, 'responses.json');
	const skillFile = path.join(tmpDir, '.agents', 'skills', 'json-canvas', 'SKILL.md');
	const offloadedFile = path.join(
		os.homedir(),
		'.gemini',
		'antigravity-test-perm',
		'brain',
		'sess-fake',
		'.system_generated',
		'steps',
		'49',
		'output.txt',
	);
	fs.writeFileSync(
		fakeBin,
		`#!/usr/bin/env node
import * as fs from 'node:fs';
import * as readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const replies = {};
let promptReqId = null;
const permission = (id, toolCallId, name, Path) => ({
	jsonrpc: '2.0',
	id,
	method: 'session/request_permission',
	params: {
		sessionId: 'sess-fake',
		toolCall: { toolCallId, title: 'Read file', rawInput: { Path } },
		options: [
			{ optionId: 'allow', kind: 'allow_once' },
			{ optionId: 'reject', kind: 'reject_once' },
		],
	},
});
rl.on('line', (line) => {
	const msg = JSON.parse(line);
	if (msg.method === 'initialize') {
		send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
		return;
	}
	if (msg.method === 'session/new') {
		send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-fake', models: { availableModels: [] } } });
		return;
	}
	if (msg.method === 'session/close') {
		send({ jsonrpc: '2.0', id: msg.id, result: {} });
		return;
	}
	if (msg.method === 'session/prompt') {
		promptReqId = msg.id;
		for (const [callId, Path] of [
			['call_skill', ${JSON.stringify(skillFile)}],
			['call_offload', ${JSON.stringify(offloadedFile)}],
			['call_other', '/etc/hosts'],
		]) {
			send({
				jsonrpc: '2.0',
				method: 'session/update',
				params: { sessionId: 'sess-fake', update: { sessionUpdate: 'tool_call', toolCallId: callId, name: 'read_file', args: { Path }, status: 'pending' } },
			});
		}
		send(permission('perm-skill', 'call_skill', 'read_file', ${JSON.stringify(skillFile)}));
		send(permission('perm-offload', 'call_offload', 'read_file', ${JSON.stringify(offloadedFile)}));
		send(permission('perm-other', 'call_other', 'read_file', '/etc/hosts'));
		send({
			jsonrpc: '2.0',
			id: 'perm-mcp',
			method: 'session/request_permission',
			params: {
				sessionId: 'sess-fake',
				toolCall: { toolCallId: 'call_mcp', name: 'call_mcp_tool', rawInput: { ServerName: 'excalidraw', ToolName: 'addRect' } },
				options: [
					{ optionId: 'allow', kind: 'allow_once' },
					{ optionId: 'reject', kind: 'reject_once' },
				],
			},
		});
		return;
	}
	if (msg.id === 'perm-skill' || msg.id === 'perm-offload' || msg.id === 'perm-other' || msg.id === 'perm-mcp') {
		replies[msg.id] = msg.result;
		if (Object.keys(replies).length === 4) {
			fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(replies));
			send({ jsonrpc: '2.0', id: promptReqId, result: { stopReason: 'end_turn' } });
		}
	}
});
`,
		{ mode: 0o755 },
	);

	const client = new AntigravityAcpClient({
		cliPath: fakeBin,
		cwd: tmpDir,
		appDataDir: 'antigravity-test-perm',
		quotaFetcher: async () => null,
	});

	try {
		const res = await client.prompt('Format this canvas');
		const replies = JSON.parse(fs.readFileSync(outFile, 'utf8'));
		assert.deepEqual(replies['perm-skill'], { outcome: { outcome: 'selected', optionId: 'allow' } });
		assert.deepEqual(replies['perm-offload'], { outcome: { outcome: 'selected', optionId: 'allow' } });
		assert.deepEqual(replies['perm-other'], { outcome: { outcome: 'selected', optionId: 'reject' } });
		assert.deepEqual(replies['perm-mcp'], { outcome: { outcome: 'selected', optionId: 'allow' } });
		// Nothing could ask about /etc/hosts: refused, and the turn says why.
		assert.deepEqual(res.blockedTools, [{ name: 'read_file', reason: 'unanswered' }]);
		assert.equal(res.answer, '');
	} finally {
		await client.destroy();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('AntigravityAcpClient asks the user, remembers "Allow for this session", and reports a refusal that agy ended as cancelled', async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antidian-ask-'));
	const fakeBin = path.join(tmpDir, 'fake-agy.mjs');
	const outFile = path.join(tmpDir, 'responses.json');
	// Per prompt, phases of permission requests; each phase waits for its replies.
	const script = [
		[
			[
				['perm-a', 'read_file', { Path: '/opt/data/a.txt' }],
				['perm-b', 'read_file', { Path: '/opt/data/b.txt' }],
			],
			[
				['perm-shell', 'run_command', { CommandLine: 'ls' }],
				['perm-late', 'list_dir', { DirectoryPath: '/srv' }],
			],
		],
		[[['perm-next', 'read_file', { Path: '/opt/data/c.txt' }]]],
		[[['perm-after-reset', 'read_file', { Path: '/opt/data/d.txt' }]]],
	];
	fs.writeFileSync(
		fakeBin,
		`#!/usr/bin/env node
import * as fs from 'node:fs';
import * as readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const script = ${JSON.stringify(script)};
const replies = {};
let promptIndex = 0;
let promptReqId = null;
let phases = [];
let waiting = new Set();
let sessionCount = 0;
const runPhase = () => {
	const phase = phases.shift();
	if (!phase) {
		fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(replies));
		if (promptIndex === 1) {
			send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-ask', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Let me look.' } } } });
			send({ jsonrpc: '2.0', id: promptReqId, result: { stopReason: 'cancelled' } });
		} else {
			send({ jsonrpc: '2.0', id: promptReqId, result: { stopReason: 'end_turn' } });
		}
		return;
	}
	waiting = new Set(phase.map(([id]) => id));
	for (const [id, name, rawInput] of phase) {
		const toolCallId = 'call-' + id;
		send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-ask', update: { sessionUpdate: 'tool_call', toolCallId, name, args: rawInput, status: 'pending' } } });
		send({
			jsonrpc: '2.0',
			id,
			method: 'session/request_permission',
			params: {
				sessionId: 'sess-ask',
				toolCall: { toolCallId, title: 'Tool', rawInput },
				options: [
					{ optionId: 'allow', kind: 'allow_once' },
					{ optionId: 'always', kind: 'allow_always' },
					{ optionId: 'reject', kind: 'reject_once' },
				],
			},
		});
	}
};
rl.on('line', (line) => {
	const msg = JSON.parse(line);
	if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
	if (msg.method === 'session/new') {
		sessionCount++;
		return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-ask-' + sessionCount, models: { availableModels: [] } } });
	}
	if (msg.method === 'session/close') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
	if (msg.method === 'session/prompt') {
		promptReqId = msg.id;
		phases = [...script[promptIndex]];
		promptIndex++;
		return runPhase();
	}
	if (msg.id !== undefined && waiting.has(msg.id)) {
		replies[msg.id] = msg.result;
		waiting.delete(msg.id);
		if (waiting.size === 0) runPhase();
	}
});
`,
		{ mode: 0o755 },
	);

	const vaultDir = path.join(tmpDir, 'vault');
	fs.mkdirSync(vaultDir);
	const client = new AntigravityAcpClient({
		cliPath: fakeBin,
		cwd: vaultDir,
		appDataDir: 'antigravity-test-ask',
		quotaFetcher: async () => null,
	});
	const asked = [];
	const onPermissionRequest = async (request) => {
		asked.push(request);
		return 'allow_session';
	};
	const readReplies = () => JSON.parse(fs.readFileSync(outFile, 'utf8'));
	const allowed = { outcome: { outcome: 'selected', optionId: 'allow' } };
	const rejected = { outcome: { outcome: 'selected', optionId: 'reject' } };

	try {
		const first = await client.prompt('Read my data', undefined, { onPermissionRequest });
		let replies = readReplies();
		// Asked once: the second read in /opt/data is covered by "Allow for this session".
		assert.equal(asked.length, 1);
		assert.equal(asked[0].toolName, 'read_file');
		assert.equal(asked[0].target, '/opt/data/a.txt');
		assert.equal(asked[0].sessionScope, 'read_file in /opt/data for this session');
		assert.equal(asked[0].planMode, false);
		assert.deepEqual(replies['perm-a'], allowed);
		assert.deepEqual(replies['perm-b'], allowed);
		// The shell command is refused without asking; after that refusal agy ends
		// the turn, so the later question is not put to the user.
		assert.deepEqual(replies['perm-shell'], rejected);
		assert.deepEqual(replies['perm-late'], rejected);
		assert.equal(asked.length, 1);
		// agy reported the refusal as `cancelled`: not the user's Stop.
		assert.equal(first.stopReason, 'blocked');
		assert.equal(first.answer, 'Let me look.');
		assert.deepEqual(first.blockedTools, [{ name: 'run_command', reason: 'shell' }]);

		const second = await client.prompt('And c', undefined, { onPermissionRequest });
		replies = readReplies();
		assert.deepEqual(replies['perm-next'], allowed);
		assert.equal(asked.length, 1);
		assert.equal(second.blockedTools, undefined);

		await client.resetSession();
		await client.prompt('And d', undefined, {
			onPermissionRequest: async (request) => {
				asked.push(request);
				return 'deny';
			},
		}).then((third) => {
			assert.deepEqual(third.blockedTools, [{ name: 'read_file', reason: 'user' }]);
		});
		replies = readReplies();
		// A new session asks again.
		assert.equal(asked.length, 2);
		assert.deepEqual(replies['perm-after-reset'], rejected);
	} finally {
		await client.destroy();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('Agent passes the permission handler on and keeps why a refused turn has no text', async () => {
	const decisions = [];
	const fakeProvider = {
		getMcpToolServer: () => undefined,
		cancel() {},
		async resetSession() {},
		async runTurn(_prompt, _media, callbacks) {
			decisions.push(
				await callbacks.onPermissionRequest({
					toolName: 'read_file',
					target: '/opt/a.txt',
					sessionScope: 'read_file in /opt for this session',
					planMode: false,
				}),
			);
			return {
				answer: '',
				stopReason: 'blocked',
				blockedTools: [{ name: 'read_file', reason: 'user' }],
			};
		},
	};
	const agent = new Agent({ provider: fakeProvider });
	const res = await agent.run(
		'read it',
		{},
		[],
		undefined,
		undefined,
		undefined,
		'ask',
		undefined,
		undefined,
		undefined,
		async () => 'deny',
	);
	assert.deepEqual(decisions, ['deny']);
	assert.equal(res.cancelled, undefined);
	assert.equal(res.answer, '');
	assert.deepEqual(res.blockedTools, [{ name: 'read_file', reason: 'user' }]);
	assert.match(res.updatedHistory.at(-1).text, /^Stopped: You denied `read_file`\./);
});
