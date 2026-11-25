import './ts-resolve.mjs';
import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { binaryMimeForPath } from '../src/core/files.ts';
import { McpToolServer } from '../src/core/models/mcp-tool-server.ts';
import { parseAgyTranscriptJsonl } from '../src/core/sessions/transcript.ts';
import { ToolRegistry, createReadNoteTool } from '../src/core/tools/index.ts';
import { ChangeSetValidator } from '../src/core/transactions/validator.ts';

const binaries = {
	'a b.png': { mimeType: 'image/png', data: 'aW1n' },
	'doc.pdf': { mimeType: 'application/pdf', data: 'cGRm' },
};
const vault = {
	async readBinary(path) {
		if (path === 'big.mp4') throw new Error('"big.mp4" is too large to read (limit 20 MB).');
		return binaries[path] ? { path, size: 3, mtime: 5, ...binaries[path] } : null;
	},
	async readNote({ path }) {
		if (path === 'x.zip') return { path, content: 'PK\0\0' };
		return { path, content: 'text', mtime: 1 };
	},
};

test('binaryMimeForPath covers media and documents, and treats SVG and unknown types as text', () => {
	assert.equal(binaryMimeForPath('Assets/Shot.PNG'), 'image/png');
	assert.equal(binaryMimeForPath('a.pdf'), 'application/pdf');
	for (const path of ['a.svg', 'a.md', 'a.canvas', 'a.base', 'noext']) {
		assert.equal(binaryMimeForPath(path), undefined);
	}
});

test('read_note returns non-text files as MCP content and keeps bytes out of UI events', async () => {
	const registry = new ToolRegistry();
	registry.register(createReadNoteTool(vault));
	const server = new McpToolServer(registry);
	const info = await server.start();
	try {
		const ended = [];
		const contextRefs = [];
		server.setTurnContext(
			{ permissionMode: 'ask', recordContext: (ref) => contextRefs.push(ref.path) },
			{ onToolEnd: (e) => ended.push(e.toolOutput) },
		);
		const read = (path) =>
			new Promise((resolve, reject) => {
				const req = http.request(
					info.url,
					{ method: 'POST', headers: { Authorization: `Bearer ${info.token}` } },
					(res) => {
						let data = '';
						res.on('data', (chunk) => (data += chunk));
						res.on('end', () => resolve(JSON.parse(data).result));
					},
				);
				req.on('error', reject);
				req.end(
					JSON.stringify({
						jsonrpc: '2.0',
						id: 1,
						method: 'tools/call',
						params: { name: 'read_note', arguments: { path } },
					}),
				);
			});

		const png = await read('a b.png');
		assert.deepEqual(png.content[1], { type: 'image', mimeType: 'image/png', data: 'aW1n' });
		const meta = JSON.parse(png.content[0].text);
		assert.equal(meta.path, 'a b.png');
		assert.equal(meta.size, 3);
		assert.equal('data' in meta, false);
		assert.equal(JSON.stringify(ended[0]).includes('aW1n'), false);
		assert.deepEqual(contextRefs, ['a b.png']);

		const pdf = await read('doc.pdf');
		assert.deepEqual(pdf.content[1], {
			type: 'resource',
			resource: { uri: 'vault:///doc.pdf', mimeType: 'application/pdf', blob: 'cGRm' },
		});

		const note = await read('n.md');
		assert.equal(note.content.length, 1);
		assert.equal(JSON.parse(note.content[0].text).content, 'text');

		for (const [path, message] of [['big.mp4', /too large/], ['x.zip', /unsupported type/]]) {
			const failed = await read(path);
			assert.equal(failed.isError, true);
			assert.match(failed.content[0].text, message);
		}
	} finally {
		await server.stop();
	}
});

test('ChangeSetValidator rejects text edits to non-text files', async () => {
	const validator = new ChangeSetValidator({
		normalizePath: (p) => p,
		isPathWithinVault: () => true,
		fileExists: async () => true,
		getFileMtime: async () => null,
		headingExists: async () => true,
		readNote: async ({ path }) => ({ path, content: path === 'a.docx' ? 'PK\0' : 'x' }),
	});
	const result = await validator.validate({
		id: 'c',
		status: 'staged',
		operations: [
			{ id: '1', type: 'append', path: 'a.png', content: 'y' },
			{ id: '2', type: 'append', path: 'a.svg', content: 'y' },
			{ id: '3', type: 'append', path: 'a.docx', content: 'y' },
		],
	});
	assert.deepEqual(result.errors.map((e) => [e.path, e.code]), [['a.png', 'binary_file'], ['a.docx', 'binary_file']]);
});

test('replayed file reads keep their structured result', () => {
	const [turn] = parseAgyTranscriptJsonl(
		[
			{ type: 'USER_INPUT', content: '<USER_REQUEST>\nhi\n</USER_REQUEST>' },
			{ type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'mcp_anti-dian-vault_read_note', args: { path: 'a.png' } }] },
			{
				type: 'GENERIC',
				content:
					'Created At: 2026-11-25T12:37:40+07:00\nCompleted At: 2026-11-25T12:37:41+07:00\n{"path":"a.png","mimeType":"image/png"}\n[Resource offloaded to file:///h/.system_generated/steps/2/media_0.png]',
			},
		]
			.map((s) => JSON.stringify(s))
			.join('\n'),
	);
	assert.deepEqual(turn.events[0].output, { path: 'a.png', mimeType: 'image/png' });
});
