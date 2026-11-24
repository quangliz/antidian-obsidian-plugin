import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { setTimeout as delay } from 'timers/promises';
import { promisify } from 'util';
import { loadTrustedCaCertificates } from './agy-diagnostics';

const execFileAsync = promisify(execFile);

export const DEFAULT_AGY_RELEASE_BASE_URL =
	'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app';
export const AGY_BINARY_SIDECAR_FILENAME = 'agy.version.json';
export const AGY_BINARY_SIDECAR_SCHEMA_VERSION = 1;
export const STAGED_BINARY_SUFFIX = '.next';
export const INSTALL_LOCK_FILENAME = '.agy-install.lock';
export const INSTALL_LOCK_STALE_MS = 15 * 60_000;
export const INSTALL_LOCK_POLL_MS = 300;
export const INSTALL_LOCK_TIMEOUT_MS = 120_000;
export const MANIFEST_CHECK_TTL_MS = 12 * 60 * 60_000;
export const DOWNLOAD_FAILURE_BACKOFF_MS = 60 * 60_000;
export const SIDECAR_MTIME_TOLERANCE_MS = 2_000;

const MAX_REDIRECTS = 5;
const MANIFEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const DOWNLOAD_MAX_ATTEMPTS = 3;
const DOWNLOAD_INITIAL_BACKOFF_MS = 500;

export interface PlatformBinaryInfo {
	url: string;
	sha512?: string;
	sha256?: string;
}

export interface ReleaseManifest {
	version: string;
	url?: string;
	sha512?: string;
	sha256?: string;
	binaries?: Record<string, PlatformBinaryInfo>;
	platforms?: Record<string, PlatformBinaryInfo>;
}

export interface StagedNextMetadata {
	version: string;
	size: number;
	mtimeMs: number;
	sha512?: string;
	releaseBaseUrl?: string;
}

export interface BinarySidecarMetadata {
	schemaVersion: number;
	version: string | null;
	size: number;
	mtimeMs: number;
	ino: number;
	installedAt: number;
	sha512?: string;
	releaseBaseUrl?: string;
	lastCheckAt?: number;
	lastDownloadFailureAt?: number;
	stagedNext?: StagedNextMetadata;
}

export interface BinaryDownloadProgress {
	phase: 'manifest' | 'downloading' | 'verifying' | 'extracting' | 'installing';
	message: string;
	downloadedBytes?: number;
	totalBytes?: number;
	percent?: number;
}

export interface EnsureAgyBinaryOptions {
	customPath?: string;
	releaseBaseUrl?: string;
	targetPath?: string;
	caCertificates?: string;
	platform?: NodeJS.Platform;
	arch?: string;
	onProgress?: (progress: BinaryDownloadProgress) => void;
	/** Injectable downloader for unit tests. */
	fetchText?: (url: string, timeoutMs: number) => Promise<string>;
	/** Injectable file downloader for unit tests. */
	downloadToFile?: (
		url: string,
		destPath: string,
		onChunk?: (downloadedBytes: number, totalBytes?: number) => void,
	) => Promise<void>;
	/** Injectable tar extractor for unit tests. */
	extractTarGz?: (archivePath: string, destDir: string) => Promise<void>;
	/** Injectable rename for testing Windows file-lock `.next` staging. */
	fsRename?: (from: string, to: string) => Promise<void>;
	/** Injectable clock for testing TTL/backoff/stale locks. */
	now?: () => number;
}

export interface EnsureAgyBinaryResult {
	binaryPath: string;
	downloaded: boolean;
	staged?: boolean;
	version?: string;
}

export interface BackgroundUpdateResult {
	status:
		| 'up_to_date'
		| 'installed'
		| 'staged'
		| 'skipped_ttl'
		| 'skipped_backoff'
		| 'skipped_locked'
		| 'error';
	version?: string;
	error?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isFileLockError(err: unknown): boolean {
	const code = isObject(err) && typeof err.code === 'string' ? err.code : '';
	return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

export function getStagedBinaryPath(binaryPath: string): string {
	return `${binaryPath}${STAGED_BINARY_SUFFIX}`;
}

export function getSidecarPath(binaryPath: string): string {
	return path.join(path.dirname(binaryPath), AGY_BINARY_SIDECAR_FILENAME);
}

/**
 * Default managed installation path, matching the official Antigravity VS Code
 * extension (`~/.gemini/bin/agy` or `agy.exe` on Windows) so both tools share
 * one verified binary without duplicate downloads.
 */
export function getManagedAgyBinaryPath(
	platform: NodeJS.Platform = process.platform,
	homeDir: string = os.homedir(),
): string {
	const name = platform === 'win32' ? 'agy.exe' : 'agy';
	return path.join(homeDir, '.gemini', 'bin', name);
}

/** Maps Node `process.platform` and `process.arch` to manifest naming. */
export function resolveManifestPlatformArch(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): { manifestPlatform: string; manifestArch: string } {
	const manifestPlatform = platform === 'win32' ? 'windows' : platform;
	const manifestArch = arch === 'x64' ? 'amd64' : arch;
	return { manifestPlatform, manifestArch };
}

export function isValidReleaseManifest(value: unknown): value is ReleaseManifest {
	if (!isObject(value)) return false;
	if (typeof value.version !== 'string' || !value.version.trim()) return false;
	return (
		typeof value.url === 'string' ||
		isObject(value.binaries) ||
		isObject(value.platforms)
	);
}

export function resolvePlatformBinaryInfo(
	manifest: ReleaseManifest,
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): PlatformBinaryInfo | undefined {
	if (manifest.url) {
		return {
			url: manifest.url,
			sha512: manifest.sha512,
			sha256: manifest.sha256,
		};
	}

	const direct = manifest.binaries?.[`${platform}-${arch}`];
	if (direct) return direct;

	const normalizedKey = `${platform === 'win32' ? 'windows' : platform}-${
		arch === 'arm64' || arch === 'aarch64' ? 'arm' : arch
	}`;
	return (
		manifest.platforms?.[normalizedKey] ?? manifest.binaries?.[normalizedKey]
	);
}

export function isTarGzUrl(rawUrl: string): boolean {
	try {
		const pathname = new URL(rawUrl).pathname.toLowerCase();
		return pathname.endsWith('.tar.gz') || pathname.endsWith('.tgz');
	} catch {
		const lower = rawUrl.toLowerCase();
		return lower.endsWith('.tar.gz') || lower.endsWith('.tgz');
	}
}

export function validateReleaseBaseUrl(rawUrl: string): string {
	const trimmed = rawUrl.trim().replace(/\/+$/, '');
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error(`Invalid release base URL: ${rawUrl}`);
	}
	const isLocalHttp =
		parsed.protocol === 'http:' &&
		(parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
	if (parsed.protocol !== 'https:' && !isLocalHttp) {
		throw new Error(
			`Refusing insecure release URL protocol "${parsed.protocol}"`,
		);
	}
	return trimmed;
}

export function compareSemver(a: string, b: string): number {
	const parse = (v: string): number[] => {
		const m = v.match(/(\d+)\.(\d+)\.(\d+)/);
		if (!m) return [0, 0, 0];
		return [Number(m[1]), Number(m[2]), Number(m[3])];
	};
	const pa = parse(a);
	const pb = parse(b);
	for (let i = 0; i < 3; i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function requestWithRedirects(
	rawUrl: string,
	timeoutMs: number,
	headers: Record<string, string> = {},
	ca?: string[],
	redirectDepth = 0,
): Promise<http.IncomingMessage> {
	return new Promise((resolve, reject) => {
		let parsed: URL;
		try {
			parsed = new URL(rawUrl);
		} catch (err) {
			reject(err instanceof Error ? err : new Error(String(err)));
			return;
		}

		const isHttps = parsed.protocol === 'https:';
		const reqOpts: https.RequestOptions = {
			timeout: timeoutMs,
			headers,
			...(isHttps && ca && ca.length > 0 ? { ca } : {}),
		};
		const req = isHttps
			? https.get(parsed, reqOpts, onResponse)
			: http.get(parsed, reqOpts, onResponse);

		function onResponse(res: http.IncomingMessage): void {
			const status = res.statusCode ?? 0;
			const location = res.headers.location;
			if (
				[301, 302, 303, 307, 308].includes(status) &&
				location &&
				redirectDepth < MAX_REDIRECTS
			) {
				res.resume();
				const nextUrl = new URL(location, parsed).toString();
				void requestWithRedirects(
					nextUrl,
					timeoutMs,
					headers,
					ca,
					redirectDepth + 1,
				).then(resolve, reject);
				return;
			}
			resolve(res);
		}

		req.on('timeout', () => {
			req.destroy(new Error(`Request timed out after ${timeoutMs}ms: ${rawUrl}`));
		});
		req.on('error', reject);
	});
}

function createFetchText(caCertificates?: string) {
	const ca = loadTrustedCaCertificates(caCertificates);
	return async (url: string, timeoutMs: number): Promise<string> => {
		const res = await requestWithRedirects(url, timeoutMs, {}, ca);
		const status = res.statusCode ?? 0;
		if (status < 200 || status >= 300) {
			res.resume();
			throw new Error(`HTTP ${status} fetching ${url}`);
		}
		const chunks: Buffer[] = [];
		for await (const chunk of res) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
		}
		return Buffer.concat(chunks).toString('utf8');
	};
}

/**
 * Downloads a file with automatic HTTP Range resume (`Range` / `If-Range` /
 * `206 Partial Content`) and exponential retry backoff.
 */
function createResumableDownloader(caCertificates?: string) {
	const ca = loadTrustedCaCertificates(caCertificates);
	return async (
		url: string,
		destPath: string,
		onChunk?: (downloadedBytes: number, totalBytes?: number) => void,
	): Promise<void> => {
		let validator: string | undefined;
		let backoffMs = DOWNLOAD_INITIAL_BACKOFF_MS;

		for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt++) {
			let existingBytes = 0;
			if (attempt > 1) {
				try {
					const st = await fs.promises.stat(destPath);
					if (st.size > 0) existingBytes = st.size;
				} catch {
					existingBytes = 0;
				}
			}

			const headers: Record<string, string> = {};
			if (existingBytes > 0) {
				headers.Range = `bytes=${existingBytes}-`;
				if (validator) {
					headers['If-Range'] = validator;
				}
			}

			try {
				const res = await requestWithRedirects(
					url,
					DOWNLOAD_TIMEOUT_MS,
					headers,
					ca,
				);
				const status = res.statusCode ?? 0;

				if (status === 416 && existingBytes > 0) {
					res.resume();
					await fs.promises.unlink(destPath).catch(() => {});
					validator = undefined;
					throw new Error('Range not satisfiable (HTTP 416); restarting from 0');
				}

				const isPartial = existingBytes > 0 && status === 206;
				if (isPartial) {
					const range = res.headers['content-range'];
					const match =
						typeof range === 'string'
							? range.match(/^bytes\s+(\d+)-\d+\/(?:\d+|\*)$/i)
							: null;
					if (!match || Number(match[1]) !== existingBytes) {
						res.resume();
						await fs.promises.unlink(destPath).catch(() => {});
						throw new Error('Server Content-Range mismatch; restarting from 0');
					}
				} else if (status < 200 || status >= 300) {
					res.resume();
					throw new Error(`HTTP ${status} downloading ${url}`);
				}

				const etag = res.headers.etag ?? res.headers['last-modified'];
				if (typeof etag === 'string' && etag) {
					validator = etag;
				}

				const rawLen = res.headers['content-length'];
				const parsedLen = rawLen ? Number(rawLen) : NaN;
				const totalBytes =
					Number.isFinite(parsedLen) && parsedLen > 0
						? isPartial
							? existingBytes + parsedLen
							: parsedLen
						: undefined;

				let downloaded = isPartial ? existingBytes : 0;
				res.on('data', (chunk: Buffer | string) => {
					downloaded += Buffer.isBuffer(chunk)
						? chunk.length
						: Buffer.byteLength(chunk);
					onChunk?.(downloaded, totalBytes);
				});

				const out = fs.createWriteStream(destPath, {
					flags: isPartial ? 'a' : 'w',
				});
				await pipeline(res, out);
				return;
			} catch (err) {
				if (attempt >= DOWNLOAD_MAX_ATTEMPTS) {
					throw err;
				}
				await delay(backoffMs);
				backoffMs *= 2;
			}
		}
	};
}

async function defaultExtractTarGz(
	archivePath: string,
	destDir: string,
): Promise<void> {
	await execFileAsync('tar', ['-xzf', archivePath, '-C', destDir]);
}

export async function computeFileChecksum(
	filePath: string,
	algorithm: 'sha512' | 'sha256',
): Promise<string> {
	const hash = crypto.createHash(algorithm);
	const stream = fs.createReadStream(filePath);
	await pipeline(stream, hash);
	return hash.digest('hex');
}

export async function fetchAgyReleaseManifest(
	releaseBaseUrl: string,
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
	fetchText: (url: string, timeoutMs: number) => Promise<string> = createFetchText(),
): Promise<ReleaseManifest> {
	const base = validateReleaseBaseUrl(releaseBaseUrl);
	const { manifestPlatform, manifestArch } = resolveManifestPlatformArch(
		platform,
		arch,
	);

	const errors: string[] = [];

	const tryJson = async (url: string): Promise<ReleaseManifest | null> => {
		try {
			const text = await fetchText(url, MANIFEST_TIMEOUT_MS);
			const parsed: unknown = JSON.parse(text);
			if (isValidReleaseManifest(parsed)) {
				return parsed;
			}
			errors.push(`${url}: invalid manifest shape`);
		} catch (err) {
			errors.push(
				`${url}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return null;
	};

	const directManifest = await tryJson(
		`${base}/manifests/${manifestPlatform}_${manifestArch}.json`,
	);
	if (directManifest) return directManifest;

	try {
		const latestText = await fetchText(`${base}/latest`, MANIFEST_TIMEOUT_MS);
		const match = latestText.match(/(\d+\.\d+\.\d+[^\s]*)/);
		const version = match?.[1] ?? latestText.trim();
		if (version) {
			const versioned = await tryJson(`${base}/${version}/manifest.json`);
			if (versioned) return versioned;
		}
	} catch (err) {
		errors.push(
			`${base}/latest: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	const fallback = await tryJson(`${base}/releases/latest/manifest.json`);
	if (fallback) return fallback;

	throw new Error(
		`Failed to fetch Antigravity release manifest:\n${errors.join('\n')}`,
	);
}

// ---------------------------------------------------------------------------
// Sidecar metadata (`agy.version.json`) — compatible with VS Code extension
// ---------------------------------------------------------------------------

export async function readValidBinarySidecar(
	binaryPath: string,
): Promise<BinarySidecarMetadata | undefined> {
	try {
		const stats = await fs.promises.stat(binaryPath);
		const raw = await fs.promises.readFile(getSidecarPath(binaryPath), 'utf8');
		const parsed: unknown = JSON.parse(raw);
		if (!isObject(parsed)) return undefined;
		if (parsed.schemaVersion !== AGY_BINARY_SIDECAR_SCHEMA_VERSION) {
			return undefined;
		}
		if (
			typeof parsed.size !== 'number' ||
			typeof parsed.mtimeMs !== 'number' ||
			typeof parsed.ino !== 'number' ||
			typeof parsed.installedAt !== 'number'
		) {
			return undefined;
		}
		if (
			parsed.size !== stats.size ||
			Math.abs(parsed.mtimeMs - stats.mtimeMs) > SIDECAR_MTIME_TOLERANCE_MS ||
			(parsed.ino !== 0 && stats.ino !== 0 && parsed.ino !== stats.ino)
		) {
			return undefined;
		}
		return parsed as unknown as BinarySidecarMetadata;
	} catch {
		return undefined;
	}
}

async function writeVersionSidecar(
	binaryPath: string,
	patch: {
		version?: string | null;
		releaseBaseUrl?: string;
		sha512?: string;
		lastCheckAt?: number;
		lastDownloadFailureAt?: number | null;
		stagedNext?: StagedNextMetadata | null;
	},
): Promise<void> {
	try {
		const stats = await fs.promises.stat(binaryPath);
		const existing = await readValidBinarySidecar(binaryPath);
		const sidecarPath = getSidecarPath(binaryPath);
		const tmpPath = `${sidecarPath}.tmp.${crypto.randomUUID().slice(0, 8)}`;

		const payload: BinarySidecarMetadata = {
			schemaVersion: AGY_BINARY_SIDECAR_SCHEMA_VERSION,
			version:
				patch.version !== undefined
					? patch.version
					: (existing?.version ?? null),
			size: stats.size,
			mtimeMs: stats.mtimeMs,
			ino: stats.ino,
			installedAt: existing?.installedAt ?? Date.now(),
			...(patch.sha512 !== undefined
				? { sha512: patch.sha512 }
				: existing?.sha512
					? { sha512: existing.sha512 }
					: {}),
			...(patch.releaseBaseUrl !== undefined
				? { releaseBaseUrl: patch.releaseBaseUrl }
				: existing?.releaseBaseUrl
					? { releaseBaseUrl: existing.releaseBaseUrl }
					: {}),
			...(patch.lastCheckAt !== undefined
				? { lastCheckAt: patch.lastCheckAt }
				: existing?.lastCheckAt !== undefined
					? { lastCheckAt: existing.lastCheckAt }
					: {}),
			...(patch.lastDownloadFailureAt === null
				? {}
				: patch.lastDownloadFailureAt !== undefined
					? { lastDownloadFailureAt: patch.lastDownloadFailureAt }
					: existing?.lastDownloadFailureAt !== undefined
						? { lastDownloadFailureAt: existing.lastDownloadFailureAt }
						: {}),
			...(patch.stagedNext === null
				? {}
				: patch.stagedNext !== undefined
					? { stagedNext: patch.stagedNext }
					: existing?.stagedNext
						? { stagedNext: existing.stagedNext }
						: {}),
		};

		await fs.promises.writeFile(
			tmpPath,
			JSON.stringify(payload, null, 2),
			'utf8',
		);
		await fs.promises.rename(tmpPath, sidecarPath);
	} catch {
		// Best-effort metadata cache
	}
}

// ---------------------------------------------------------------------------
// Cross-window install lock (`.agy-install.lock`)
// ---------------------------------------------------------------------------

interface InstallLockPayload {
	pid: number;
	hostname: string;
	createdAt: number;
}

function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return isObject(err) && err.code === 'EPERM';
	}
}

export function isInstallLockStale(
	payload: InstallLockPayload,
	opts?: {
		now?: number;
		currentHostname?: string;
		staleThresholdMs?: number;
		checkPidAlive?: (pid: number) => boolean;
	},
): boolean {
	const now = opts?.now ?? Date.now();
	const threshold = opts?.staleThresholdMs ?? INSTALL_LOCK_STALE_MS;
	if (now - payload.createdAt > threshold || payload.createdAt - now > threshold) {
		return true;
	}
	const host = opts?.currentHostname ?? os.hostname();
	if (payload.hostname === host) {
		const check = opts?.checkPidAlive ?? isPidAlive;
		if (!check(payload.pid)) return true;
	}
	return false;
}

async function readInstallLock(
	lockPath: string,
): Promise<InstallLockPayload | 'missing' | 'corrupt'> {
	try {
		const raw = await fs.promises.readFile(lockPath, 'utf8');
		const parsed: unknown = JSON.parse(raw);
		if (
			isObject(parsed) &&
			typeof parsed.pid === 'number' &&
			typeof parsed.hostname === 'string' &&
			typeof parsed.createdAt === 'number'
		) {
			return {
				pid: parsed.pid,
				hostname: parsed.hostname,
				createdAt: parsed.createdAt,
			};
		}
		return 'corrupt';
	} catch (err) {
		return isObject(err) && err.code === 'ENOENT' ? 'missing' : 'corrupt';
	}
}

export async function withInstallLock<T>(
	installDir: string,
	action: () => Promise<T>,
	opts?: {
		now?: () => number;
		timeoutMs?: number;
		pollMs?: number;
		onContended?: () => T | undefined;
	},
): Promise<T> {
	await fs.promises.mkdir(installDir, { recursive: true });
	const lockPath = path.join(installDir, INSTALL_LOCK_FILENAME);
	const nowFn = opts?.now ?? Date.now;
	const timeoutMs = opts?.timeoutMs ?? INSTALL_LOCK_TIMEOUT_MS;
	const pollMs = opts?.pollMs ?? INSTALL_LOCK_POLL_MS;
	const payload: InstallLockPayload = {
		pid: process.pid,
		hostname: os.hostname(),
		createdAt: nowFn(),
	};

	const startedAt = nowFn();
	let acquired = false;

	while (nowFn() - startedAt < timeoutMs) {
		try {
			const handle = await fs.promises.open(lockPath, 'wx');
			try {
				await handle.writeFile(JSON.stringify(payload), 'utf8');
			} finally {
				await handle.close().catch(() => {});
			}
			acquired = true;
			break;
		} catch (err) {
			if (!isObject(err) || err.code !== 'EEXIST') {
				break;
			}
			const existing = await readInstallLock(lockPath);
			if (existing === 'missing') {
				continue;
			}
			if (
				existing === 'corrupt' ||
				isInstallLockStale(existing, { now: nowFn() })
			) {
				await fs.promises.unlink(lockPath).catch(() => {});
				continue;
			}
			const contendedResult = opts?.onContended?.();
			if (contendedResult !== undefined) {
				return contendedResult;
			}
			await delay(pollMs);
		}
	}

	try {
		return await action();
	} finally {
		if (acquired) {
			const current = await readInstallLock(lockPath);
			if (
				current !== 'missing' &&
				current !== 'corrupt' &&
				current.pid === payload.pid &&
				current.createdAt === payload.createdAt
			) {
				await fs.promises.unlink(lockPath).catch(() => {});
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Promotion, `.next` staging, and stale artifact cleanup
// ---------------------------------------------------------------------------

async function promoteBinarySafely(
	sourcePath: string,
	targetPath: string,
	platform: NodeJS.Platform,
	fsRename: (from: string, to: string) => Promise<void> = fs.promises.rename,
	stageOnLock?: string,
): Promise<{ staged: boolean }> {
	if (platform !== 'win32') {
		await fs.promises.chmod(sourcePath, 0o755);
	}

	try {
		if (platform !== 'win32') {
			await fsRename(sourcePath, targetPath);
			return { staged: false };
		}

		const backupPath = `${targetPath}.old.${crypto.randomUUID().slice(0, 8)}`;
		let backedUp = false;
		if (fs.existsSync(targetPath)) {
			try {
				await fsRename(targetPath, backupPath);
				backedUp = true;
			} catch (err) {
				if (stageOnLock && isFileLockError(err)) {
					await fs.promises.unlink(stageOnLock).catch(() => {});
					await fs.promises.rename(sourcePath, stageOnLock);
					return { staged: true };
				}
				throw err;
			}
		}

		try {
			await fsRename(sourcePath, targetPath);
			if (backedUp) {
				await fs.promises.unlink(backupPath).catch(() => {});
			}
			return { staged: false };
		} catch (err) {
			if (backedUp) {
				await fsRename(backupPath, targetPath).catch(() => {});
			}
			throw err;
		}
	} catch (err) {
		if (stageOnLock && isFileLockError(err)) {
			await fs.promises.unlink(stageOnLock).catch(() => {});
			await fs.promises.rename(sourcePath, stageOnLock);
			return { staged: true };
		}
		throw err;
	}
}

/**
 * Promotes a previously staged `agy.next` binary into `targetPath` before
 * spawning `agy`, matching the VS Code extension's deferred upgrade flow.
 */
export async function promoteStagedBinaryIfAny(
	targetPath: string,
	platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
	const stagedPath = getStagedBinaryPath(targetPath);
	let stagedStats: fs.Stats;
	try {
		stagedStats = await fs.promises.stat(stagedPath);
	} catch {
		return false;
	}

	const sidecar = await readValidBinarySidecar(targetPath);
	const stagedMeta = sidecar?.stagedNext;
	const matchesSidecar =
		stagedMeta !== undefined &&
		stagedMeta.size === stagedStats.size &&
		Math.abs(stagedMeta.mtimeMs - stagedStats.mtimeMs) <=
			SIDECAR_MTIME_TOLERANCE_MS;

	if (!matchesSidecar) {
		await fs.promises.unlink(stagedPath).catch(() => {});
		return false;
	}

	try {
		const { staged } = await promoteBinarySafely(stagedPath, targetPath, platform);
		if (staged) return false;
		await writeVersionSidecar(targetPath, {
			version: stagedMeta.version,
			sha512: stagedMeta.sha512,
			releaseBaseUrl: stagedMeta.releaseBaseUrl ?? sidecar?.releaseBaseUrl,
			lastCheckAt: sidecar?.lastCheckAt ?? Date.now(),
			lastDownloadFailureAt: null,
			stagedNext: null,
		});
		return true;
	} catch {
		return false;
	}
}

export async function cleanupStaleDownloadArtifacts(
	installDir: string,
): Promise<void> {
	try {
		const entries = await fs.promises.readdir(installDir, {
			withFileTypes: true,
		});
		for (const entry of entries) {
			const isTmp =
				entry.isFile() &&
				(/^agy\.tmp\.[0-9a-f-]+(?:\.tar\.gz)?$/i.test(entry.name) ||
					/^.+\.old\.[0-9a-f]{8}$/i.test(entry.name));
			const isUnpack =
				entry.isDirectory() && /^\.unpack_[0-9a-f]{8}$/i.test(entry.name);
			if (!isTmp && !isUnpack) continue;
			await fs.promises
				.rm(path.join(installDir, entry.name), { recursive: true, force: true })
				.catch(() => {});
		}
	} catch {
		// Directory may not exist yet
	}
}

async function downloadAndInstallAgyBinary(
	options: EnsureAgyBinaryOptions,
	opts: { allowStageOnLock: boolean },
): Promise<EnsureAgyBinaryResult> {
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const releaseBaseUrl = validateReleaseBaseUrl(
		options.releaseBaseUrl ?? DEFAULT_AGY_RELEASE_BASE_URL,
	);
	const targetPath = options.targetPath ?? getManagedAgyBinaryPath(platform);
	const installDir = path.dirname(targetPath);
	const fetchText = options.fetchText ?? createFetchText(options.caCertificates);
	const downloadToFile =
		options.downloadToFile ?? createResumableDownloader(options.caCertificates);
	const extractTarGz = options.extractTarGz ?? defaultExtractTarGz;
	const nowFn = options.now ?? Date.now;

	options.onProgress?.({
		phase: 'manifest',
		message: 'Checking latest Antigravity backend release...',
	});

	const manifest = await fetchAgyReleaseManifest(
		releaseBaseUrl,
		platform,
		arch,
		fetchText,
	);
	const binaryInfo = resolvePlatformBinaryInfo(manifest, platform, arch);
	if (!binaryInfo) {
		throw new Error(
			`No Antigravity binary available in release manifest for ${platform}-${arch}`,
		);
	}

	const expectedChecksum = binaryInfo.sha512 ?? binaryInfo.sha256;
	const algorithm: 'sha512' | 'sha256' = binaryInfo.sha512 ? 'sha512' : 'sha256';
	if (!expectedChecksum) {
		throw new Error(
			'Release manifest is missing a sha512 or sha256 checksum; refusing unverified binary.',
		);
	}

	await fs.promises.mkdir(installDir, { recursive: true });

	const archive = isTarGzUrl(binaryInfo.url);
	const tmpFile = path.join(
		installDir,
		`agy.tmp.${crypto.randomUUID()}${archive ? '.tar.gz' : ''}`,
	);
	let unpackDir: string | null = null;

	try {
		options.onProgress?.({
			phase: 'downloading',
			message: `Downloading Antigravity backend v${manifest.version}...`,
			percent: 0,
		});

		let lastPercent = -1;
		await downloadToFile(binaryInfo.url, tmpFile, (downloaded, total) => {
			const percent =
				total && total > 0
					? Math.min(100, Math.floor((downloaded / total) * 100))
					: undefined;
			if (percent === undefined || percent !== lastPercent) {
				lastPercent = percent ?? lastPercent;
				options.onProgress?.({
					phase: 'downloading',
					message:
						percent !== undefined
							? `Downloading Antigravity backend v${manifest.version} (${percent}%)...`
							: `Downloading Antigravity backend v${manifest.version}...`,
					downloadedBytes: downloaded,
					totalBytes: total,
					percent,
				});
			}
		});

		options.onProgress?.({
			phase: 'verifying',
			message: `Verifying ${algorithm.toUpperCase()} checksum...`,
		});

		const actualChecksum = await computeFileChecksum(tmpFile, algorithm);
		if (actualChecksum.toLowerCase() !== expectedChecksum.toLowerCase()) {
			throw new Error(
				`${algorithm.toUpperCase()} checksum mismatch for Antigravity binary`,
			);
		}

		let binaryToPromote = tmpFile;
		if (archive) {
			options.onProgress?.({
				phase: 'extracting',
				message: 'Extracting Antigravity backend...',
			});
			unpackDir = path.join(
				installDir,
				`.unpack_${crypto.randomUUID().slice(0, 8)}`,
			);
			await fs.promises.mkdir(unpackDir, { recursive: true });
			await extractTarGz(tmpFile, unpackDir);

			const ext = platform === 'win32' ? '.exe' : '';
			const candidateNames = [
				`antigravity${ext}`,
				`agy${ext}`,
				`cli${ext}`,
				path.join('bin', `antigravity${ext}`),
				path.join('bin', `agy${ext}`),
				path.join('bin', `cli${ext}`),
			];

			const found = candidateNames
				.map((rel) => path.join(unpackDir as string, rel))
				.find((candidate) => fs.existsSync(candidate));

			if (!found) {
				throw new Error(
					'Could not find agy executable inside downloaded archive',
				);
			}
			binaryToPromote = found;
		}

		options.onProgress?.({
			phase: 'installing',
			message: `Installing Antigravity backend v${manifest.version}...`,
		});

		const stagedPath = opts.allowStageOnLock
			? getStagedBinaryPath(targetPath)
			: undefined;
		const { staged } = await promoteBinarySafely(
			binaryToPromote,
			targetPath,
			platform,
			options.fsRename,
			stagedPath,
		);

		if (staged && stagedPath) {
			const stagedStats = await fs.promises.stat(stagedPath);
			await writeVersionSidecar(targetPath, {
				lastCheckAt: nowFn(),
				lastDownloadFailureAt: null,
				stagedNext: {
					version: manifest.version,
					size: stagedStats.size,
					mtimeMs: stagedStats.mtimeMs,
					...(binaryInfo.sha512 ? { sha512: binaryInfo.sha512 } : {}),
					releaseBaseUrl,
				},
			});
			return {
				binaryPath: targetPath,
				downloaded: true,
				staged: true,
				version: manifest.version,
			};
		}

		await fs.promises.unlink(getStagedBinaryPath(targetPath)).catch(() => {});
		await writeVersionSidecar(targetPath, {
			version: manifest.version,
			releaseBaseUrl,
			sha512: binaryInfo.sha512,
			lastCheckAt: nowFn(),
			lastDownloadFailureAt: null,
			stagedNext: null,
		});

		return {
			binaryPath: targetPath,
			downloaded: true,
			staged: false,
			version: manifest.version,
		};
	} finally {
		await fs.promises.unlink(tmpFile).catch(() => {});
		if (unpackDir) {
			await fs.promises
				.rm(unpackDir, { recursive: true, force: true })
				.catch(() => {});
		}
	}
}

const inFlightDownloads = new Map<string, Promise<EnsureAgyBinaryResult>>();

/**
 * Ensures an `agy` binary is available on disk, promoting any staged `.next`
 * update first and downloading/verifying into `~/.gemini/bin/agy` when absent.
 */
export async function ensureAgyBinary(
	options: EnsureAgyBinaryOptions = {},
	isExistingAvailable?: (customPath?: string) => string | null,
): Promise<EnsureAgyBinaryResult> {
	const customPath = options.customPath?.trim();
	if (customPath) {
		if (!fs.existsSync(customPath)) {
			throw new Error(
				`Configured Antigravity CLI path does not exist: ${customPath}`,
			);
		}
		return { binaryPath: customPath, downloaded: false };
	}

	const platform = options.platform ?? process.platform;
	const managedPath = options.targetPath ?? getManagedAgyBinaryPath(platform);
	await promoteStagedBinaryIfAny(managedPath, platform);

	if (isExistingAvailable) {
		const existing = isExistingAvailable(customPath);
		if (existing) {
			return { binaryPath: existing, downloaded: false };
		}
	} else if (fs.existsSync(managedPath)) {
		return { binaryPath: managedPath, downloaded: false };
	}

	const existingFlight = inFlightDownloads.get(managedPath);
	if (existingFlight) {
		return existingFlight;
	}

	const installDir = path.dirname(managedPath);
	const task = withInstallLock(
		installDir,
		async () => {
			await cleanupStaleDownloadArtifacts(installDir);
			if (fs.existsSync(managedPath)) {
				return { binaryPath: managedPath, downloaded: false };
			}
			return downloadAndInstallAgyBinary(options, { allowStageOnLock: false });
		},
		{ now: options.now },
	).finally(() => {
		inFlightDownloads.delete(managedPath);
	});

	inFlightDownloads.set(managedPath, task);
	return task;
}

/**
 * Checks for a newer `agy` release in the background (respecting a 12h TTL and
 * 1h failure backoff) and installs or stages it as `agy.next` if locked.
 */
export async function checkAndStageAgyUpdate(
	options: EnsureAgyBinaryOptions = {},
): Promise<BackgroundUpdateResult> {
	if (options.customPath?.trim()) {
		return { status: 'up_to_date' };
	}

	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const targetPath = options.targetPath ?? getManagedAgyBinaryPath(platform);
	if (!fs.existsSync(targetPath)) {
		return { status: 'up_to_date' };
	}

	const nowFn = options.now ?? Date.now;
	const now = nowFn();
	const sidecar = await readValidBinarySidecar(targetPath);

	if (
		sidecar?.lastCheckAt !== undefined &&
		now >= sidecar.lastCheckAt &&
		now - sidecar.lastCheckAt < MANIFEST_CHECK_TTL_MS
	) {
		return { status: 'skipped_ttl', version: sidecar.version ?? undefined };
	}

	if (
		sidecar?.lastDownloadFailureAt !== undefined &&
		now >= sidecar.lastDownloadFailureAt &&
		now - sidecar.lastDownloadFailureAt < DOWNLOAD_FAILURE_BACKOFF_MS
	) {
		return { status: 'skipped_backoff', version: sidecar.version ?? undefined };
	}

	const releaseBaseUrl = validateReleaseBaseUrl(
		options.releaseBaseUrl ?? DEFAULT_AGY_RELEASE_BASE_URL,
	);
	const fetchText = options.fetchText ?? createFetchText(options.caCertificates);

	try {
		const manifest = await fetchAgyReleaseManifest(
			releaseBaseUrl,
			platform,
			arch,
			fetchText,
		);
		const info = resolvePlatformBinaryInfo(manifest, platform, arch);
		const installedVersion = sidecar?.stagedNext?.version ?? sidecar?.version;
		const installedSha = sidecar?.stagedNext?.sha512 ?? sidecar?.sha512;

		const sameOrNewer =
			typeof installedVersion === 'string' &&
			compareSemver(installedVersion, manifest.version) >= 0;
		const sameChecksum =
			Boolean(installedSha) &&
			Boolean(info?.sha512) &&
			installedSha?.toLowerCase() === info?.sha512?.toLowerCase();

		if (sameOrNewer && (!info?.sha512 || !installedSha || sameChecksum)) {
			await writeVersionSidecar(targetPath, { lastCheckAt: now });
			return { status: 'up_to_date', version: installedVersion };
		}

		const installDir = path.dirname(targetPath);
		const result = await withInstallLock<BackgroundUpdateResult>(
			installDir,
			async () => {
				const res = await downloadAndInstallAgyBinary(options, {
					allowStageOnLock: true,
				});
				return {
					status: res.staged ? 'staged' : 'installed',
					version: res.version,
				};
			},
			{
				now: nowFn,
				onContended: () => ({ status: 'skipped_locked' }),
			},
		);
		return result;
	} catch (err) {
		await writeVersionSidecar(targetPath, { lastDownloadFailureAt: now });
		return {
			status: 'error',
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
