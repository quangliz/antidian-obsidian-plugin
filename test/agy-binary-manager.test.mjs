import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
	AGY_BINARY_SIDECAR_FILENAME,
	INSTALL_LOCK_FILENAME,
	MANIFEST_CHECK_TTL_MS,
	checkAndStageAgyUpdate,
	ensureAgyBinary,
	fetchAgyReleaseManifest,
	getManagedAgyBinaryPath,
	getStagedBinaryPath,
	isInstallLockStale,
	isValidReleaseManifest,
	promoteStagedBinaryIfAny,
	resolveManifestPlatformArch,
	resolvePlatformBinaryInfo,
	validateReleaseBaseUrl,
	withInstallLock,
} from '../src/core/models/agy-binary-manager.ts';
import {
	buildAgySecurityEnv,
	categorizeProcessFailure,
	checkLinuxX64CpuSupport,
	formatProcessExitError,
	isNonRetriableFailure,
	readCliLogTailFallback,
	wasSuspendedSince,
} from '../src/core/models/agy-diagnostics.ts';
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

test('AntigravityAcpClient hydrates model choices, tier, and quota immediately from initialCache', () => {
	const now = Date.now();
	const client = new AntigravityAcpClient({
		initialCache: {
			modelConfig: {
				model: {
					current: 'gemini-4-neon',
					options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }],
				},
			},
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

	assert.equal(client.getModelConfig()?.model.current, 'gemini-4-neon');
	// A snapshot saved by an older version has no model choices.
	const older = new AntigravityAcpClient({ initialCache: { models: [{ id: 'x' }] } });
	assert.equal(older.getModelConfig(), null);

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

test('checkAndStageAgyUpdate stages .next when locked and promotes on next startup', async () => {
	const dir = makeTempDir();
	try {
		const targetPath = path.join(dir, 'bin', 'agy');
		const v1 = Buffer.from('v1-binary');
		const v2 = Buffer.from('v2-binary-updated');
		let clock = 1_000_000;

		// Install v1
		await ensureAgyBinary({
			targetPath,
			platform: 'linux',
			arch: 'x64',
			now: () => clock,
			releaseBaseUrl: 'https://updates.example.com',
			fetchText: async () =>
				JSON.stringify({
					version: '1.5.10',
					url: 'https://updates.example.com/agy',
					sha512: sha512Hex(v1),
				}),
			downloadToFile: async (_url, dest) => fs.writeFileSync(dest, v1),
		});

		// Within 12h TTL -> skipped_ttl
		const ttlRes = await checkAndStageAgyUpdate({
			targetPath,
			platform: 'linux',
			arch: 'x64',
			now: () => clock + 60_000,
			fetchText: async () => {
				throw new Error('Should not fetch within TTL');
			},
		});
		assert.equal(ttlRes.status, 'skipped_ttl');

		// After 12h, simulate EBUSY lock on rename -> stages agy.next
		clock += MANIFEST_CHECK_TTL_MS + 1000;
		const stageRes = await checkAndStageAgyUpdate({
			targetPath,
			platform: 'linux',
			arch: 'x64',
			now: () => clock,
			releaseBaseUrl: 'https://updates.example.com',
			fetchText: async () =>
				JSON.stringify({
					version: '1.5.16',
					url: 'https://updates.example.com/agy',
					sha512: sha512Hex(v2),
				}),
			downloadToFile: async (_url, dest) => fs.writeFileSync(dest, v2),
			fsRename: async () => {
				const err = new Error('resource busy');
				err.code = 'EBUSY';
				throw err;
			},
		});

		assert.equal(stageRes.status, 'staged');
		assert.equal(stageRes.version, '1.5.16');
		assert.equal(fs.existsSync(getStagedBinaryPath(targetPath)), true);
		assert.deepEqual(fs.readFileSync(targetPath), v1);

		// Next startup promotes agy.next -> agy
		const promoted = await promoteStagedBinaryIfAny(targetPath, 'linux');
		assert.equal(promoted, true);
		assert.equal(fs.existsSync(getStagedBinaryPath(targetPath)), false);
		assert.deepEqual(fs.readFileSync(targetPath), v2);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('withInstallLock cleans up stale lock and detects live lock contention', async () => {
	const dir = makeTempDir();
	try {
		const lockPath = path.join(dir, INSTALL_LOCK_FILENAME);
		// Dead/stale lock is reclaimed automatically
		fs.writeFileSync(
			lockPath,
			JSON.stringify({ pid: 999999, hostname: os.hostname(), createdAt: 1 }),
		);
		assert.equal(
			isInstallLockStale(
				{ pid: 999999, hostname: os.hostname(), createdAt: Date.now() },
				{ checkPidAlive: () => false },
			),
			true,
		);

		let ran = false;
		await withInstallLock(dir, async () => {
			ran = true;
		});
		assert.equal(ran, true);
		assert.equal(fs.existsSync(lockPath), false);

		// Live lock triggers onContended fast-path
		fs.writeFileSync(
			lockPath,
			JSON.stringify({
				pid: process.pid,
				hostname: os.hostname(),
				createdAt: Date.now(),
			}),
		);
		const contended = await withInstallLock(
			dir,
			async () => 'ran',
			{ onContended: () => 'skipped' },
		);
		assert.equal(contended, 'skipped');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('diagnostics detect CPU flags, failure categories, suspend drift, CA env, and cli.log tail', () => {
	const missingAvx = checkLinuxX64CpuSupport({
		platform: 'linux',
		arch: 'x64',
		readCpuInfo: () =>
			'model name\t: Old Xeon\nflags\t\t: sse4_1 sse4_2 ssse3 popcnt cx16 avx\n',
	});
	assert.equal(missingAvx.supported, false);
	assert.deepEqual(missingAvx.missingFlags, ['avx2', 'bmi1', 'bmi2', 'fma']);
	assert.equal(missingAvx.modelName, 'Old Xeon');

	assert.equal(categorizeProcessFailure({ exitCode: 132 }), 'killed_by_SIGILL');
	assert.equal(isNonRetriableFailure('killed_by_SIGILL'), true);
	assert.equal(isNonRetriableFailure('process_exit_nonzero'), false);
	assert.match(
		formatProcessExitError({ exitCode: 132, cpuCheck: missingAvx }),
		/x86-64-v3.*avx2/i,
	);
	assert.equal(
		wasSuspendedSince(10_000, 1_000, 40_000, 2_000),
		true,
	);
	assert.equal(
		wasSuspendedSince(10_000, 1_000, 12_000, 3_000),
		false,
	);

	const env = buildAgySecurityEnv(
		{ PATH: '/usr/bin' },
		{
			caCertificates: '/corp/ca.pem',
			platform: 'darwin',
			fsExists: (p) => p === '/corp/ca.pem' || p === '/etc/ssl/cert.pem',
			extraBinDirs: ['/home/u/.gemini/bin'],
		},
	);
	assert.equal(env.AGY_CA_CERT, '/corp/ca.pem');
	assert.equal(env.NODE_EXTRA_CA_CERTS, '/corp/ca.pem');
	assert.equal(env.SSL_CERT_FILE, '/etc/ssl/cert.pem');
	assert.equal(env.NODE_USE_SYSTEM_CA, '1');
	assert.ok(env.PATH?.startsWith('/home/u/.gemini/bin'));

	// Windows names the variable `Path`; a second `PATH` would hide System32.
	const winEnv = buildAgySecurityEnv(
		{ Path: 'C:\\Windows\\System32;C:\\Windows' },
		{ platform: 'win32', extraBinDirs: ['C:\\Users\\u\\.gemini\\bin'] },
	);
	assert.equal(
		winEnv.Path,
		'C:\\Users\\u\\.gemini\\bin;C:\\Windows\\System32;C:\\Windows',
	);
	assert.equal('PATH' in winEnv, false);

	const fakeHome = makeTempDir();
	try {
		const logDir = path.join(fakeHome, '.gemini', 'antigravity-anti-dian');
		fs.mkdirSync(logDir, { recursive: true });
		fs.writeFileSync(path.join(logDir, 'cli.log'), 'line1\nfatal: boom\n');
		const tail = readCliLogTailFallback(
			Date.now() - 1000,
			'antigravity-anti-dian',
			fakeHome,
		);
		assert.match(tail ?? '', /fatal: boom/);
	} finally {
		fs.rmSync(fakeHome, { recursive: true, force: true });
	}
});
