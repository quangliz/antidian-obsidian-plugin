import './ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isSkillFilePath } from '../src/core/skills/index.ts';
import {
	AntigravityAcpClient,
	blockedToolsReply,
	readFileRoots,
} from '../src/core/models/antigravity-acp.ts';

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

test('readFileRoots lists only the skill folders and agy MCP tool schemas', () => {
	const roots = readFileRoots('/vault', 'antigravity-anti-dian', '/home/u');
	assert.deepEqual(roots, [
		'/vault/.agents/skills',
		'/home/u/.agents/skills',
		'/home/u/.gemini/antigravity-anti-dian/mcp',
	]);
	assert.equal(isSkillFilePath('/home/u/.gemini/antigravity-anti-dian/mcp/excalidraw/addRect.json', roots), true);
	assert.equal(isSkillFilePath('/home/u/.gemini/antigravity-anti-dian/brain/x.md', roots), false);
});

test('blockedToolsReply names refused tools, or nothing when none were refused', () => {
	assert.equal(blockedToolsReply([]), undefined);
	assert.match(blockedToolsReply(['read_file', 'run_command']), /`read_file`, `run_command`/);
});

test('AntigravityAcpClient allows skill reads, refuses other built-ins, and explains an empty turn', async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antidian-perm-'));
	const fakeBin = path.join(tmpDir, 'fake-agy.mjs');
	const outFile = path.join(tmpDir, 'responses.json');
	const skillFile = path.join(tmpDir, '.agents', 'skills', 'json-canvas', 'SKILL.md');
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
		for (const [callId, Path] of [['call_skill', ${JSON.stringify(skillFile)}], ['call_other', '/etc/hosts']]) {
			send({
				jsonrpc: '2.0',
				method: 'session/update',
				params: { sessionId: 'sess-fake', update: { sessionUpdate: 'tool_call', toolCallId: callId, name: 'read_file', args: { Path }, status: 'pending' } },
			});
		}
		send(permission('perm-skill', 'call_skill', 'read_file', ${JSON.stringify(skillFile)}));
		send(permission('perm-other', 'call_other', 'read_file', '/etc/hosts'));
		return;
	}
	if (msg.id === 'perm-skill' || msg.id === 'perm-other') {
		replies[msg.id] = msg.result;
		if (Object.keys(replies).length === 2) {
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
		quotaFetcher: async () => null,
	});

	try {
		const res = await client.prompt('Format this canvas');
		const replies = JSON.parse(fs.readFileSync(outFile, 'utf8'));
		assert.deepEqual(replies['perm-skill'], { outcome: { outcome: 'selected', optionId: 'allow' } });
		assert.deepEqual(replies['perm-other'], { outcome: { outcome: 'selected', optionId: 'reject' } });
		assert.match(res.answer, /blocked the built-in tool `read_file`/);
	} finally {
		await client.destroy();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});
