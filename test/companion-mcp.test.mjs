import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	normalizeCompanionMcpServer,
	toAcpHttpMcpServer,
} from '../src/core/types/companion-mcp.ts';

describe('companion MCP discovery helpers', () => {
	it('accepts valid -antidian plugin descriptors on loopback HTTP', () => {
		const res = normalizeCompanionMcpServer(
			'excalidraw-mcp-antidian',
			'Excalidraw MCP',
			{
				name: 'excalidraw',
				url: 'http://127.0.0.1:27129/mcp',
				headers: [{ name: 'Authorization', value: 'Bearer secret' }],
				description: 'Control Excalidraw drawings.',
				version: '0.1.0',
			},
			new Set(['antidian-vault']),
		);

		assert.deepEqual(res, {
			pluginId: 'excalidraw-mcp-antidian',
			pluginName: 'Excalidraw MCP',
			serverName: 'excalidraw',
			url: 'http://127.0.0.1:27129/mcp',
			headers: [{ name: 'Authorization', value: 'Bearer secret' }],
			description: 'Control Excalidraw drawings.',
			version: '0.1.0',
		});

		assert.ok(res);
		assert.deepEqual(toAcpHttpMcpServer(res), {
			type: 'http',
			name: 'excalidraw',
			url: 'http://127.0.0.1:27129/mcp',
			headers: [{ name: 'Authorization', value: 'Bearer secret' }],
		});
	});

	it('accepts localhost URLs without headers', () => {
		const res = normalizeCompanionMcpServer('canvas-antidian', 'Canvas Companion', {
			name: 'canvas_tools',
			url: 'http://localhost:31000/mcp',
		});
		assert.ok(res);
		assert.deepEqual(toAcpHttpMcpServer(res), {
			type: 'http',
			name: 'canvas_tools',
			url: 'http://localhost:31000/mcp',
		});
	});

	it('rejects plugin IDs without -antidian suffix', () => {
		assert.equal(
			normalizeCompanionMcpServer('excalidraw-mcp', 'Excalidraw MCP', {
				name: 'excalidraw',
				url: 'http://127.0.0.1:27129/mcp',
			}),
			null,
		);
	});

	it('rejects non-loopback or non-HTTP URLs', () => {
		for (const url of [
			'https://127.0.0.1:27129/mcp',
			'https://evil.example/mcp',
			'http://192.168.1.10:27129/mcp',
			'http://0.0.0.0:27129/mcp',
			'not-a-url',
		]) {
			assert.equal(
				normalizeCompanionMcpServer('foo-antidian', 'Foo', { name: 'foo', url }),
				null,
			);
		}
	});

	it('rejects reserved or malformed server names and invalid headers', () => {
		assert.equal(
			normalizeCompanionMcpServer(
				'foo-antidian',
				'Foo',
				{ name: 'antidian-vault', url: 'http://127.0.0.1:27129/mcp' },
				new Set(['antidian-vault']),
			),
			null,
		);
		assert.equal(
			normalizeCompanionMcpServer('foo-antidian', 'Foo', {
				name: 'Bad Name!',
				url: 'http://127.0.0.1:27129/mcp',
			}),
			null,
		);
		assert.equal(
			normalizeCompanionMcpServer('foo-antidian', 'Foo', {
				name: 'foo',
				url: 'http://127.0.0.1:27129/mcp',
				headers: [{ name: '', value: 'x' }],
			}),
			null,
		);
	});
});
