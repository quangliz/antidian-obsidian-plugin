import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LEGACY_PLUGIN_ID, MCP_SERVER_NAME, stripMcpPrefix } from '../src/core/legacy-names.ts';
import {
	APP_DATA_DIR,
	LEGACY_APP_DATA_DIR,
	resolveAppDataDir,
} from '../src/core/models/app-data-dir.ts';

// Assembled so that a project-wide rename cannot rewrite the expected value too.
const FORMER_ID = ['anti', 'dian'].join('-');
const CURRENT_ID = ['anti', 'dian'].join('');

test('the former plugin id stays distinct from the current one', () => {
	const manifest = JSON.parse(
		fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'),
	);
	assert.equal(LEGACY_PLUGIN_ID, FORMER_ID);
	assert.equal(manifest.id, CURRENT_ID);
	assert.equal(MCP_SERVER_NAME, `${CURRENT_ID}-vault`);
	assert.equal(LEGACY_APP_DATA_DIR, `antigravity-${FORMER_ID}`);
	assert.equal(APP_DATA_DIR, `antigravity-${CURRENT_ID}`);
});

test('stripMcpPrefix handles current and former vault tool names', () => {
	assert.equal(stripMcpPrefix(`mcp_${CURRENT_ID}-vault_read_note`), 'read_note');
	assert.equal(stripMcpPrefix(`mcp_${FORMER_ID}-vault_read_note`), 'read_note');
	assert.equal(stripMcpPrefix('search_web'), 'search_web');
	assert.equal(stripMcpPrefix('mcp_other_read_note'), 'mcp_other_read_note');
});

test('resolveAppDataDir keeps the former data dir until a new one exists', () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antidian-home-'));
	const make = (dir) => fs.mkdirSync(path.join(home, '.gemini', dir), { recursive: true });
	try {
		assert.equal(resolveAppDataDir(home), APP_DATA_DIR);
		make(LEGACY_APP_DATA_DIR);
		assert.equal(resolveAppDataDir(home), LEGACY_APP_DATA_DIR);
		make(APP_DATA_DIR);
		assert.equal(resolveAppDataDir(home), APP_DATA_DIR);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});
