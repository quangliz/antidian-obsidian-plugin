import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	formatArgsLines,
	formatKeyValueLines,
	listMcpServers,
	parseArgsLines,
	parseKeyValueLines,
	readMcpConfig,
	removeMcpServer,
	setMcpServerEnabled,
	upsertMcpServer,
} from '../src/core/models/mcp-config.ts';

function withTempConfig(fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antidian-mcp-'));
	const configPath = path.join(dir, 'mcp_config.json');
	try {
		return fn(configPath);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe('mcp-config', () => {
	it('returns an empty server map when config file does not exist', () => {
		withTempConfig((configPath) => {
			assert.deepEqual(readMcpConfig(configPath), { mcpServers: {} });
			assert.deepEqual(listMcpServers(configPath), []);
		});
	});

	it('adds, lists, toggles, edits, renames, and removes stdio and http servers', () => {
		withTempConfig((configPath) => {
			upsertMcpServer(
				'excalidraw',
				{
					type: 'stdio',
					command: 'node',
					args: ['/tmp/server.js'],
					env: { DEBUG: '1' },
					enabled: true,
				},
				{ configPath },
			);
			upsertMcpServer(
				'remote',
				{
					type: 'http',
					serverUrl: 'https://example.com/mcp',
					headers: { Authorization: 'Bearer tok' },
					enabled: false,
				},
				{ configPath },
			);

			const listed = listMcpServers(configPath);
			assert.equal(listed.length, 2);
			assert.equal(listed[0].name, 'excalidraw');
			assert.equal(listed[0].type, 'stdio');
			assert.equal(listed[0].enabled, true);
			assert.equal(listed[0].summary, 'node /tmp/server.js');
			assert.equal(listed[1].name, 'remote');
			assert.equal(listed[1].type, 'http');
			assert.equal(listed[1].enabled, false);
			assert.equal(listed[1].summary, 'https://example.com/mcp');

			setMcpServerEnabled('excalidraw', false, configPath);
			assert.equal(listMcpServers(configPath)[0].enabled, false);

			upsertMcpServer(
				'excalidraw-v2',
				{
					type: 'stdio',
					command: 'node',
					args: ['/tmp/v2.js'],
					enabled: true,
				},
				{ previousName: 'excalidraw', configPath },
			);
			const afterRename = listMcpServers(configPath);
			assert.deepEqual(
				afterRename.map((s) => s.name),
				['excalidraw-v2', 'remote'],
			);

			removeMcpServer('remote', configPath);
			assert.deepEqual(
				listMcpServers(configPath).map((s) => s.name),
				['excalidraw-v2'],
			);
		});
	});

	it('preserves unknown top-level and server fields on update', () => {
		withTempConfig((configPath) => {
			fs.writeFileSync(
				configPath,
				JSON.stringify({
					customTop: true,
					mcpServers: {
						demo: {
							command: 'npx',
							args: ['-y', 'demo'],
							customField: 42,
						},
					},
				}),
			);

			setMcpServerEnabled('demo', false, configPath);
			const saved = readMcpConfig(configPath);
			assert.equal(saved.customTop, true);
			assert.equal(saved.mcpServers.demo.customField, 42);
			assert.equal(saved.mcpServers.demo.disabled, true);
		});
	});

	it('parses and formats args, env vars, and headers', () => {
		assert.deepEqual(parseArgsLines('  -y \n\n /path/with spaces/s.js '), [
			'-y',
			'/path/with spaces/s.js',
		]);
		assert.equal(formatArgsLines(['-y', 'foo']), '-y\nfoo');

		assert.deepEqual(parseKeyValueLines('FOO=bar=baz\nEMPTY=', '='), {
			FOO: 'bar=baz',
			EMPTY: '',
		});
		assert.equal(
			formatKeyValueLines({ Authorization: 'Bearer x' }, ':'),
			'Authorization: Bearer x',
		);
		assert.throws(() => parseKeyValueLines('INVALID_LINE', '='));
	});
});
