import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
	AGY_BINARY_SIDECAR_FILENAME,
	ensureAgyBinary,
	fetchAgyReleaseManifest,
	getManagedAgyBinaryPath,
	isValidReleaseManifest,
	resolveManifestPlatformArch,
	resolvePlatformBinaryInfo,
	validateReleaseBaseUrl,
} from '../src/core/models/agy-binary-manager.ts';
import {
	AntigravityAcpClient,
	QUOTA_FRESH_TTL_MS,
} from '../src/core/models/antigravity-acp.ts';

function sha512Hex(buf) {
	return crypto.createHash('sha512').update(buf).digest('hex');
}

function makeTempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'anti-dian-agy-test-'));
}

test('getManagedAgyBinaryPath matches VS Code extension path', () => {
	assert.equal(
		getManagedAgyBinaryPath('linux', '/home/alice'),
		path.join('/home/alice', '.gemini', 'bin', 'agy'),
	);
	assert.equal(
		getManagedAgyBinaryPath('win32', 'C:\\Users\\alice'),
		path.join('C:\\Users\\alice', '.gemini', 'bin', 'agy.exe'),
	);
});

test('resolveManifestPlatformArch maps win32 and x64', () => {
	assert.deepEqual(resolveManifestPlatformArch('linux', 'x64'), {
		manifestPlatform: 'linux',
		manifestArch: 'amd64',
	});
	assert.deepEqual(resolveManifestPlatformArch('win32', 'x64'), {
		manifestPlatform: 'windows',
		manifestArch: 'amd64',
	});
	assert.deepEqual(resolveManifestPlatformArch('darwin', 'arm64'), {
		manifestPlatform: 'darwin',
		manifestArch: 'arm64',
	});
});

test('validateReleaseBaseUrl allows https and loopback http only', () => {
	assert.equal(
		validateReleaseBaseUrl('https://example.com/releases/'),
		'https://example.com/releases',
	);
	assert.equal(
		validateReleaseBaseUrl('http://127.0.0.1:8080/'),
		'http://127.0.0.1:8080',
	);
	assert.throws(
		() => validateReleaseBaseUrl('http://example.com/releases'),
		/insecure/i,
	);
});

test('resolvePlatformBinaryInfo handles flat url, binaries, and platforms', () => {
	assert.deepEqual(
		resolvePlatformBinaryInfo(
			{ version: '1.5.16', url: 'https://x/agy.tar.gz', sha512: 'abc' },
			'linux',
			'x64',
		),
		{ url: 'https://x/agy.tar.gz', sha512: 'abc', sha256: undefined },
	);

	assert.deepEqual(
		resolvePlatformBinaryInfo(
			{
				version: '1.5.16',
				platforms: {
					'windows-arm': { url: 'https://x/win-arm.exe', sha256: 'def' },
				},
			},
			'win32',
			'arm64',
		),
		{ url: 'https://x/win-arm.exe', sha256: 'def' },
	);

	assert.equal(isValidReleaseManifest({ version: '1.0.0' }), false);
	assert.equal(
		isValidReleaseManifest({ version: '1.0.0', url: 'https://x/a' }),
		true,
	);
});

test('fetchAgyReleaseManifest falls back from manifests to latest', async () => {
	const seen = [];
	const manifest = await fetchAgyReleaseManifest(
		'https://updates.example.com',
		'linux',
		'x64',
		async (url) => {
			seen.push(url);
			if (url.endsWith('/manifests/linux_amd64.json')) {
				throw new Error('HTTP 404');
			}
			if (url.endsWith('/latest')) {
				return '1.5.16\n';
			}
			if (url.endsWith('/1.5.16/manifest.json')) {
				return JSON.stringify({
					version: '1.5.16',
					url: 'https://updates.example.com/agy',
					sha512: 'deadbeef',
				});
			}
			throw new Error(`Unexpected URL ${url}`);
		},
	);

	assert.equal(manifest.version, '1.5.16');
	assert.deepEqual(seen, [
		'https://updates.example.com/manifests/linux_amd64.json',
		'https://updates.example.com/latest',
		'https://updates.example.com/1.5.16/manifest.json',
	]);
});

test('ensureAgyBinary downloads, verifies sha512, installs, and writes sidecar', async () => {
	const dir = makeTempDir();
	try {
		const targetPath = path.join(dir, 'bin', 'agy');
		const payload = Buffer.from('#!/bin/sh\necho 1.5.16\n', 'utf8');
		const checksum = sha512Hex(payload);
		const phases = [];

		const result = await ensureAgyBinary({
			targetPath,
			platform: 'linux',
			arch: 'x64',
			releaseBaseUrl: 'https://updates.example.com',
			onProgress: (p) => phases.push(p.phase),
			fetchText: async () =>
				JSON.stringify({
					version: '1.5.16',
					url: 'https://updates.example.com/bin/agy',
					sha512: checksum,
				}),
			downloadToFile: async (_url, dest, onChunk) => {
				fs.writeFileSync(dest, payload);
				onChunk?.(payload.length, payload.length);
			},
		});

		assert.equal(result.downloaded, true);
		assert.equal(result.binaryPath, targetPath);
		assert.equal(result.version, '1.5.16');
		assert.deepEqual(fs.readFileSync(targetPath), payload);
		assert.ok(phases.includes('manifest'));
		assert.ok(phases.includes('downloading'));
		assert.ok(phases.includes('verifying'));
		assert.ok(phases.includes('installing'));

		const sidecar = JSON.parse(
			fs.readFileSync(
				path.join(dir, 'bin', AGY_BINARY_SIDECAR_FILENAME),
				'utf8',
			),
		);
		assert.equal(sidecar.version, '1.5.16');
		assert.equal(sidecar.sha512, checksum);

		// Second call reuses installed binary without downloading again
		const second = await ensureAgyBinary({
			targetPath,
			platform: 'linux',
			arch: 'x64',
			fetchText: async () => {
				throw new Error('Should not fetch when already installed');
			},
		});
		assert.equal(second.downloaded, false);
		assert.equal(second.binaryPath, targetPath);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('ensureAgyBinary rejects checksum mismatch and cleans up temp file', async () => {
	const dir = makeTempDir();
	try {
		const targetPath = path.join(dir, 'bin', 'agy');
		await assert.rejects(
			() =>
				ensureAgyBinary({
					targetPath,
					platform: 'linux',
					arch: 'x64',
					releaseBaseUrl: 'https://updates.example.com',
					fetchText: async () =>
						JSON.stringify({
							version: '1.5.16',
							url: 'https://updates.example.com/bin/agy',
							sha512: '0'.repeat(128),
						}),
					downloadToFile: async (_url, dest) => {
						fs.writeFileSync(dest, 'corrupted');
					},
				}),
			/checksum mismatch/i,
		);

		assert.equal(fs.existsSync(targetPath), false);
		const leftovers = fs.readdirSync(path.join(dir, 'bin'));
		assert.deepEqual(leftovers, []);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('ensureAgyBinary extracts tar.gz archive and deduplicates concurrent downloads', async () => {
	const dir = makeTempDir();
	try {
		const targetPath = path.join(dir, 'bin', 'agy');
		const archiveBytes = Buffer.from('fake-tar-gz-bytes');
		const checksum = sha512Hex(archiveBytes);
		let downloadCalls = 0;

		const opts = {
			targetPath,
			platform: 'linux',
			arch: 'x64',
			releaseBaseUrl: 'https://updates.example.com',
			fetchText: async () =>
				JSON.stringify({
					version: '1.5.16',
					url: 'https://updates.example.com/cli_linux_x64.tar.gz',
					sha512: checksum,
				}),
			downloadToFile: async (_url, dest) => {
				downloadCalls++;
				await delay(25);
				fs.writeFileSync(dest, archiveBytes);
			},
			extractTarGz: async (_archive, destDir) => {
				fs.mkdirSync(path.join(destDir, 'bin'), { recursive: true });
				fs.writeFileSync(path.join(destDir, 'bin', 'agy'), 'extracted-bin');
			},
		};

		const [r1, r2] = await Promise.all([
			ensureAgyBinary(opts),
			ensureAgyBinary(opts),
		]);

		assert.equal(downloadCalls, 1);
		assert.equal(r1.binaryPath, targetPath);
		assert.equal(r2.binaryPath, targetPath);
		assert.equal(fs.readFileSync(targetPath, 'utf8'), 'extracted-bin');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('ensureAgyBinary respects explicit customPath without downloading', async () => {
	const dir = makeTempDir();
	try {
		const custom = path.join(dir, 'custom-agy');
		await assert.rejects(
			() => ensureAgyBinary({ customPath: custom }),
			/does not exist/i,
		);

		fs.writeFileSync(custom, 'bin');
		const res = await ensureAgyBinary({ customPath: custom });
		assert.equal(res.downloaded, false);
		assert.equal(res.binaryPath, custom);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('AntigravityAcpClient hydrates models, tier, and quota immediately from initialCache', () => {
	const now = Date.now();
	const client = new AntigravityAcpClient({
		initialCache: {
			models: [
				{ id: 'gemini-4-neon-high', displayName: 'Gemini 4 Neon (High)' },
				{ id: 'gemini-4-neon-medium', displayName: 'Gemini 4 Neon (Medium)' },
			],
			defaultModelId: 'gemini-4-neon-high',
			accountTier: { tierId: 'pro', tierName: 'Google AI Pro' },
			quota: {
				fetchedAt: now,
				groups: [
					{
						name: 'Gemini Models',
						buckets: [
							{
								id: 'weekly',
								name: 'Weekly Limit Remaining',
								remainingFraction: 0.85,
							},
						],
					},
				],
			},
		},
	});

	const models = client.getCachedAvailableModels();
	assert.ok(models);
	assert.equal(models.models.length, 2);
	assert.equal(models.groups.length, 1);
	assert.equal(models.groups[0].baseName, 'Gemini 4 Neon');
	assert.equal(models.defaultModelId, 'gemini-4-neon-high');

	assert.equal(client.getAccountTier()?.tierName, 'Google AI Pro');

	const quota = client.getCachedUserQuota();
	assert.ok(quota);
	assert.equal(quota.isStale, false);
	assert.equal(quota.data.groups[0].buckets[0].remainingFraction, 0.85);
});

test('fetchUserQuota deduplicates concurrent fetches and emits cache updates', async () => {
	let fetchCalls = 0;
	let persisted = null;

	const client = new AntigravityAcpClient({
		onCacheUpdate: (snapshot) => {
			persisted = snapshot;
		},
		quotaFetcher: async () => {
			fetchCalls++;
			await delay(20);
			return {
				groups: [
					{
						name: 'Gemini Models',
						buckets: [
							{
								id: '5h',
								name: 'Five Hour Limit Remaining',
								remainingFraction: 0.5,
							},
						],
					},
				],
			};
		},
	});

	const [q1, q2] = await Promise.all([
		client.fetchUserQuota(),
		client.fetchUserQuota(),
	]);

	assert.equal(fetchCalls, 1);
	assert.equal(q1?.groups[0].buckets[0].remainingFraction, 0.5);
	assert.equal(q2?.groups[0].buckets[0].remainingFraction, 0.5);
	assert.ok(persisted?.quota);
	assert.equal(persisted.quota.groups[0].buckets[0].remainingFraction, 0.5);

	const q3 = await client.fetchUserQuota();
	assert.equal(fetchCalls, 1);
	assert.equal(q3?.groups[0].buckets[0].remainingFraction, 0.5);
});

test('getCachedUserQuota marks old cache stale and fetchUserQuota falls back to stale data on error', async () => {
	const staleTime = Date.now() - QUOTA_FRESH_TTL_MS - 10_000;
	const client = new AntigravityAcpClient({
		initialCache: {
			quota: {
				fetchedAt: staleTime,
				groups: [
					{
						name: 'Gemini Models',
						buckets: [
							{
								id: 'weekly',
								name: 'Weekly Limit Remaining',
								remainingFraction: 0.72,
							},
						],
					},
				],
			},
		},
		quotaFetcher: async () => {
			throw new Error('network error');
		},
	});

	const snap = client.getCachedUserQuota();
	assert.ok(snap);
	assert.equal(snap.isStale, true);

	const fallback = await client.fetchUserQuota();
	assert.equal(fallback?.groups[0].buckets[0].remainingFraction, 0.72);
});
