import './ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AntigravityAcpClient } from '../src/core/models/antigravity-acp.ts';

/** A fake `agy` that dies on the prompt "die" and can only resume while `gone` is absent. */
async function withClient(run, options) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-dian-reconnect-'));
	const bin = path.join(dir, 'fake-agy.mjs');
	const log = path.join(dir, 'log.jsonl');
	const gone = path.join(dir, 'gone');
	fs.writeFileSync(log, '');
	fs.writeFileSync(
		bin,
		`#!/usr/bin/env node
import * as fs from 'node:fs';
import * as readline from 'node:readline';
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
	const { id, method, params } = JSON.parse(line);
	fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method, sessionId: params?.sessionId, methodId: params?.methodId, pid: process.pid }) + '\\n');
	if (method === 'authenticate') {
		if (fs.existsSync(${JSON.stringify(path.join(dir, 'deny'))})) {
			return send({ id, error: { code: -32603, message: 'sign-in was denied' } });
		}
		return send({ id, result: {} });
	}
	if (method === 'session/new') return send({ id, result: { sessionId: 'new-' + process.pid + '-' + id } });
	if (method === 'session/load') {
		if (params.sessionId === 'missing') return send({ id, error: { code: -32603, message: 'Session not found' } });
		const usage = (sessionId, used) =>
			send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'usage_update', used, size: 1000 } } });
		usage(params.sessionId, 420);
		usage('another', 0);
		return send({ id, result: {} });
	}
	if (method === 'session/resume' && fs.existsSync(${JSON.stringify(gone)})) {
		return send({ id, error: { code: -32603, message: 'Failed to read session' } });
	}
	if (method === 'session/prompt') {
		if (params.prompt[0].text === 'die') process.exit(1);
		return send({ id, result: { stopReason: 'end_turn' } });
	}
	if (id !== undefined) send({ id, result: {} });
});
`,
		{ mode: 0o755 },
	);
	const client = new AntigravityAcpClient({
		cliPath: bin,
		cwd: dir,
		quotaFetcher: async () => null,
		...options,
	});
	let seen = 0;
	/** Session requests since the last call, as `method sessionId`. */
	const requests = () => {
		const all = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
		const fresh = all.slice(seen);
		seen = all.length;
		return fresh
			.filter((r) => /^session\/(new|resume|load|prompt)$/.test(r.method))
			.map((r) => [r.method.slice(8), r.sessionId].filter(Boolean).join(' '));
	};
	try {
		await run(client, {
			requests,
			loseSessions: () => fs.writeFileSync(gone, ''),
			denyLogin: () => fs.writeFileSync(path.join(dir, 'deny'), ''),
			rawLog: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
		});
	} finally {
		await client.destroy();
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test('AntigravityAcpClient resumes the open conversation after the process dies', async () => {
	await withClient(async (client, agy) => {
		await client.prompt('hi');
		const id = client.getSessionId();
		await assert.rejects(client.prompt('die'));
		assert.equal(client.getSessionId(), id);
		agy.requests();

		await client.prompt('still there?');
		assert.equal(client.getSessionId(), id);
		assert.deepEqual(agy.requests(), [`resume ${id}`, `prompt ${id}`]);

		// A session opened from the history counts before its first prompt, too.
		await client.loadSession('stored');
		client.setCaCertificates('/nowhere.pem');
		agy.requests();
		await client.prompt('hello');
		assert.deepEqual(agy.requests(), ['resume stored', 'prompt stored']);
	});
});

test('AntigravityAcpClient starts anew when there is no conversation to resume', async () => {
	await withClient(async (client, agy) => {
		// A session nobody has written in.
		await client.fetchModelConfig();
		client.setCaCertificates('/nowhere.pem');
		await client.prompt('first');
		const id = client.getSessionId();
		assert.deepEqual(agy.requests(), ['new', 'new', `prompt ${id}`]);

		// New session while the process is down.
		await assert.rejects(client.prompt('die'));
		await client.resetSession();
		assert.equal(client.getSessionId(), null);
		agy.requests();
		await client.prompt('second');
		assert.notEqual(client.getSessionId(), id);
		assert.deepEqual(agy.requests(), ['new', `prompt ${client.getSessionId()}`]);

		// New session while reconnecting.
		await assert.rejects(client.prompt('die'));
		const dropped = client.getSessionId();
		const starting = client.fetchModelConfig();
		await client.resetSession();
		await starting;
		assert.notEqual(client.getSessionId(), dropped);
	});
});

test('AntigravityAcpClient keeps running when unchanged settings are saved', async () => {
	await withClient(
		async (client, agy) => {
			await client.fetchModelConfig();
			client.setCaCertificates('');
			await client.fetchModelConfig();
			assert.deepEqual(agy.requests(), ['new']);
		},
		{ caCertificates: '' },
	);
});

test('AntigravityAcpClient keeps the context usage reported while a session loads', async () => {
	await withClient(async (client, agy) => {
		await client.loadSession('stored');
		assert.deepEqual(client.getContextUsage(), { used: 420, size: 1000 });

		// A failed load leaves no conversation to reconnect to.
		await assert.rejects(client.loadSession('missing'), /Session not found/);
		assert.equal(client.getSessionId(), null);
		agy.requests();
		await client.prompt('hi');
		assert.deepEqual(agy.requests(), ['new', `prompt ${client.getSessionId()}`]);
	});
});

test('AntigravityAcpClient reports a conversation it cannot resume instead of forgetting it', async () => {
	await withClient(async (client, agy) => {
		await client.prompt('hi');
		const id = client.getSessionId();
		agy.loseSessions();
		await assert.rejects(client.prompt('die'));
		agy.requests();
		await assert.rejects(client.prompt('again'), /Could not reconnect to this conversation/);
		assert.deepEqual(agy.requests(), [`resume ${id}`]);

		await client.resetSession();
		await client.prompt('fresh');
		assert.notEqual(client.getSessionId(), id);
	});
});

test('AntigravityAcpClient signs in through the browser auth method', async () => {
	await withClient(async (client, agy) => {
		await client.prompt('hi');
		const id = client.getSessionId();
		const progress = [];
		await client.login((p) => progress.push(p.phase));
		assert.deepEqual(progress, ['signing-in']);

		const log = agy.rawLog();
		const auth = log.find((r) => r.method === 'authenticate');
		assert.equal(auth.methodId, 'oauth-personal');
		assert.notEqual(auth.pid, log.find((r) => r.method === 'session/new').pid);

		// The conversation goes on in a process with the new credentials.
		agy.requests();
		await client.prompt('again');
		assert.deepEqual(agy.requests(), [`resume ${id}`, `prompt ${id}`]);
	});
});

test('AntigravityAcpClient reports why a sign-in failed and keeps the session', async () => {
	await withClient(async (client, agy) => {
		await client.prompt('hi');
		const id = client.getSessionId();
		agy.denyLogin();
		await assert.rejects(client.login(), /sign-in was denied/);
		agy.requests();
		await client.prompt('again');
		assert.deepEqual(agy.requests(), [`prompt ${id}`]);
	});
});
