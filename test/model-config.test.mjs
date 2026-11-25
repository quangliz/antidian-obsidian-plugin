import './ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	AntigravityAcpClient,
	parseModelConfig,
} from '../src/core/models/antigravity-acp.ts';

test('parseModelConfig reads model and thinking-level choices and rejects bad data', () => {
	assert.deepEqual(
		parseModelConfig([
			{ id: 'mode', currentValue: 'default', options: [{ value: 'default' }] },
			{
				id: 'model',
				currentValue: 'a',
				options: [{ value: 'a', name: 'Model A' }, { value: 'b' }, { name: 'no value' }, null],
			},
			{ id: 'thought_level', currentValue: 'low', options: [{ value: 'low', name: 'Low' }] },
		]),
		{
			model: {
				current: 'a',
				options: [
					{ value: 'a', name: 'Model A' },
					{ value: 'b', name: 'b' },
				],
			},
			thoughtLevel: { current: 'low', options: [{ value: 'low', name: 'Low' }] },
		},
	);
	// Models without a choice of thinking level report no such option.
	assert.equal(
		parseModelConfig([{ id: 'model', currentValue: 'a', options: [{ value: 'a' }] }])?.thoughtLevel,
		undefined,
	);
	assert.equal(parseModelConfig([{ id: 'model', currentValue: 'a', options: [] }]), null);
	assert.equal(parseModelConfig(undefined), null);
});

/** A fake `agy` whose models offer different levels; logs the requests it gets. */
function fakeAgy(dir) {
	const bin = path.join(dir, 'fake-agy.mjs');
	const log = path.join(dir, 'log.jsonl');
	fs.writeFileSync(
		bin,
		`#!/usr/bin/env node
import * as fs from 'node:fs';
import * as readline from 'node:readline';
const LEVELS = { fast: ['low', 'high'], deep: ['low', 'high', 'xhigh'], plain: [] };
let model = 'fast', level = 'high';
const config = () => [
	{ id: 'model', currentValue: model, options: Object.keys(LEVELS).map((value) => ({ value })) },
	...(LEVELS[model].length
		? [{ id: 'thought_level', currentValue: level, options: LEVELS[model].map((value) => ({ value })) }]
		: []),
];
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
	const { id, method, params } = JSON.parse(line);
	fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method, params }) + '\\n');
	if (method === 'session/new' || method === 'session/load') {
		model = 'fast';
		level = 'high';
		return send({ id, result: { sessionId: 's', configOptions: config() } });
	}
	if (method === 'session/set_config_option') {
		if (params.configId === 'model') {
			const [base, suffix] = params.value.split('-');
			if (!LEVELS[base]) return send({ id, error: { code: -32602, message: 'Unknown model ID' } });
			model = base;
			if (suffix) level = suffix;
			else if (!LEVELS[base].includes(level)) level = 'high';
		} else level = params.value;
		return send({ id, result: { configOptions: config() } });
	}
	if (method === 'session/prompt') return send({ id, result: { stopReason: 'end_turn' } });
	if (id !== undefined) send({ id, result: {} });
});
`,
		{ mode: 0o755 },
	);
	const requests = () =>
		fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
	return {
		bin,
		requests,
		configCalls: () =>
			requests()
				.filter((r) => r.method === 'session/set_config_option')
				.map((r) => `${r.params.configId}=${r.params.value}`),
	};
}

async function withClient(options, run) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-dian-model-'));
	const agy = fakeAgy(dir);
	const client = new AntigravityAcpClient({
		cliPath: agy.bin,
		cwd: dir,
		quotaFetcher: async () => null,
		...options,
	});
	try {
		await run(client, agy);
	} finally {
		await client.destroy();
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test('AntigravityAcpClient applies the wanted model and level to new and loaded sessions', async () => {
	await withClient({ model: 'deep', thoughtLevel: 'xhigh' }, async (client, agy) => {
		const config = await client.fetchModelConfig();
		assert.equal(config.model.current, 'deep');
		assert.equal(config.thoughtLevel.current, 'xhigh');
		assert.deepEqual(agy.configCalls(), ['model=deep', 'thought_level=xhigh']);

		// Nothing to change before a prompt.
		await client.prompt('hi');
		assert.equal(agy.configCalls().length, 2);

		// The CLI does not remember either in a stored session.
		await client.loadSession('other');
		assert.deepEqual(agy.configCalls().slice(2), ['model=deep', 'thought_level=xhigh']);
	});
});

test('AntigravityAcpClient skips a level the model does not offer and restores it later', async () => {
	await withClient({ model: 'deep', thoughtLevel: 'xhigh' }, async (client) => {
		await client.fetchModelConfig();
		client.setModel('fast');
		await client.prompt('a');
		assert.equal(client.getModelConfig().thoughtLevel.current, 'high');
		client.setModel('plain');
		await client.prompt('b');
		assert.equal(client.getModelConfig().thoughtLevel, undefined);
		client.setModel('deep');
		await client.prompt('c');
		assert.equal(client.getModelConfig().thoughtLevel.current, 'xhigh');
	});
});

test('AntigravityAcpClient reports the levels of a model chosen without a session', async () => {
	await withClient({ model: 'fast' }, async (client, agy) => {
		await client.fetchModelConfig();
		await client.resetSession();
		assert.equal(client.getSessionId(), null);

		const until = async (done) => {
			for (let i = 0; i < 200 && !done(); i++) {
				await sleep(10);
			}
		};
		client.setModel('deep');
		client.setThoughtLevel('low');
		await until(() => client.getModelConfig().thoughtLevel?.current === 'low');
		const config = client.getModelConfig();
		assert.equal(config.model.current, 'deep');
		assert.equal(config.thoughtLevel?.current, 'low');
		assert.deepEqual(
			config.thoughtLevel.options.map((o) => o.value),
			['low', 'high', 'xhigh'],
		);
		// Both choices share one new session, which the next prompt then uses.
		await client.prompt('hi');
		assert.equal(agy.requests().filter((r) => r.method === 'session/new').length, 2);

		// A level chosen without a session shows up as well.
		await client.resetSession();
		client.setThoughtLevel('xhigh');
		await until(() => client.getModelConfig().thoughtLevel?.current === 'xhigh');
		assert.equal(client.getModelConfig().thoughtLevel?.current, 'xhigh');
	});
});

test('AntigravityAcpClient shows cached levels at once when there is no session', async () => {
	let cache;
	const levels = (client) => {
		const { model, thoughtLevel } = client.getModelConfig();
		return [model.current, thoughtLevel?.current, thoughtLevel?.options.length];
	};
	await withClient({ model: 'fast', onCacheUpdate: (c) => (cache = structuredClone(c)) }, async (client) => {
		await client.fetchModelConfig();
		for (const model of ['deep', 'plain', 'fast']) {
			client.setModel(model);
			await client.prompt('learn');
		}
		await client.resetSession();
		client.setModel('deep');
		assert.deepEqual(levels(client), ['deep', 'high', 3]);
		client.setThoughtLevel('xhigh');
		assert.deepEqual(levels(client), ['deep', 'xhigh', 3]);
		client.setModel('fast');
		assert.deepEqual(levels(client), ['fast', 'high', 2]);
		client.setModel('plain');
		assert.deepEqual(levels(client), ['plain', undefined, undefined]);
	});
	assert.deepEqual(Object.keys(cache.thoughtLevels).sort(), ['deep', 'fast']);

	// After a restart, before `agy` has started.
	await withClient({ model: 'deep', thoughtLevel: 'low', initialCache: cache }, async (client, agy) => {
		assert.deepEqual(levels(client), ['deep', 'low', 3]);
		// What was shown early must not stop the choice from being sent.
		await client.prompt('hi');
		assert.deepEqual(agy.configCalls(), ['model=deep', 'thought_level=low']);
		assert.deepEqual(levels(client), ['deep', 'low', 3]);
	});
});

test('AntigravityAcpClient accepts a saved model ID with its level and survives a removed model', async () => {
	await withClient({ model: 'deep-low' }, async (client, agy) => {
		const config = await client.fetchModelConfig();
		assert.equal(config.model.current, 'deep');
		assert.equal(config.thoughtLevel.current, 'low');
		await client.prompt('hi');
		assert.deepEqual(agy.configCalls(), ['model=deep-low']);
	});
	await withClient({ model: 'gone' }, async (client) => {
		assert.equal((await client.fetchModelConfig()).model.current, 'fast');
		assert.equal((await client.prompt('hi')).stopReason, 'end_turn');
	});
});

test('AntigravityAcpClient sends context as a resource ahead of the typed text', async () => {
	await withClient({}, async (client, agy) => {
		await client.prompt('/daily', undefined, undefined, undefined, '[Current Active Note: x]');
		await client.prompt('plain');
		const prompts = agy
			.requests()
			.filter((r) => r.method === 'session/prompt')
			.map((r) => r.params.prompt);
		assert.deepEqual(prompts, [
			[
				{
					type: 'resource',
					resource: {
						uri: 'file:///anti-dian/obsidian-context.md',
						mimeType: 'text/markdown',
						text: '[Current Active Note: x]',
					},
				},
				{ type: 'text', text: '/daily' },
			],
			[{ type: 'text', text: 'plain' }],
		]);
	});
});
