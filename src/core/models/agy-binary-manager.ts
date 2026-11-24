import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const DEFAULT_AGY_RELEASE_BASE_URL =
	'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app';
export const AGY_BINARY_SIDECAR_FILENAME = 'agy.version.json';
export const AGY_BINARY_SIDECAR_SCHEMA_VERSION = 1;

const MAX_REDIRECTS = 5;
const MANIFEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

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
}

export interface EnsureAgyBinaryResult {
	binaryPath: string;
	downloaded: boolean;
	version?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
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

function requestWithRedirects(
	rawUrl: string,
	timeoutMs: number,
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

		const client = parsed.protocol === 'https:' ? https : http;
		const req = client.get(parsed, { timeout: timeoutMs }, (res) => {
			const status = res.statusCode ?? 0;
			const location = res.headers.location;
			if (
				[301, 302, 303, 307, 308].includes(status) &&
				location &&
				redirectDepth < MAX_REDIRECTS
			) {
				res.resume();
				const nextUrl = new URL(location, parsed).toString();
				void requestWithRedirects(nextUrl, timeoutMs, redirectDepth + 1).then(
					resolve,
					reject,
				);
				return;
			}
			if (status < 200 || status >= 300) {
				res.resume();
				reject(new Error(`HTTP ${status} fetching ${rawUrl}`));
				return;
			}
			resolve(res);
		});

		req.on('timeout', () => {
			req.destroy(new Error(`Request timed out after ${timeoutMs}ms: ${rawUrl}`));
		});
		req.on('error', reject);
	});
}

async function defaultFetchText(url: string, timeoutMs: number): Promise<string> {
	const res = await requestWithRedirects(url, timeoutMs);
	const chunks: Buffer[] = [];
	for await (const chunk of res) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
	}
	return Buffer.concat(chunks).toString('utf8');
}

async function defaultDownloadToFile(
	url: string,
	destPath: string,
	onChunk?: (downloadedBytes: number, totalBytes?: number) => void,
): Promise<void> {
	const res = await requestWithRedirects(url, DOWNLOAD_TIMEOUT_MS);
	const rawLength = res.headers['content-length'];
	const parsedLength = rawLength ? Number(rawLength) : NaN;
	const totalBytes =
		Number.isFinite(parsedLength) && parsedLength > 0 ? parsedLength : undefined;

	let downloaded = 0;
	res.on('data', (chunk: Buffer | string) => {
		downloaded += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
		onChunk?.(downloaded, totalBytes);
	});

	const out = fs.createWriteStream(destPath);
	await pipeline(res, out);
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
	fetchText: (url: string, timeoutMs: number) => Promise<string> = defaultFetchText,
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

async function promoteBinarySafely(
	sourcePath: string,
	targetPath: string,
	platform: NodeJS.Platform,
): Promise<void> {
	if (platform !== 'win32') {
		await fs.promises.chmod(sourcePath, 0o755);
		await fs.promises.rename(sourcePath, targetPath);
		return;
	}

	const backupPath = `${targetPath}.old.${crypto.randomUUID().slice(0, 8)}`;
	let backedUp = false;
	if (fs.existsSync(targetPath)) {
		try {
			await fs.promises.rename(targetPath, backupPath);
			backedUp = true;
		} catch {
			// Attempt direct rename below
		}
	}

	try {
		await fs.promises.rename(sourcePath, targetPath);
		if (backedUp) {
			await fs.promises.unlink(backupPath).catch(() => {});
		}
	} catch (err) {
		if (backedUp) {
			await fs.promises.rename(backupPath, targetPath).catch(() => {});
		}
		throw err;
	}
}

async function writeVersionSidecar(
	binaryPath: string,
	version: string,
	releaseBaseUrl: string,
	sha512?: string,
): Promise<void> {
	try {
		const stats = await fs.promises.stat(binaryPath);
		const sidecarPath = path.join(
			path.dirname(binaryPath),
			AGY_BINARY_SIDECAR_FILENAME,
		);
		const tmpPath = `${sidecarPath}.tmp.${crypto.randomUUID().slice(0, 8)}`;
		const payload = {
			schemaVersion: AGY_BINARY_SIDECAR_SCHEMA_VERSION,
			version,
			size: stats.size,
			mtimeMs: stats.mtimeMs,
			ino: stats.ino,
			installedAt: Date.now(),
			...(sha512 ? { sha512 } : {}),
			releaseBaseUrl,
			lastCheckAt: Date.now(),
		};
		await fs.promises.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
		await fs.promises.rename(tmpPath, sidecarPath);
	} catch {
		// Sidecar is best-effort cache metadata
	}
}

async function downloadAndInstallAgyBinary(
	options: EnsureAgyBinaryOptions,
): Promise<EnsureAgyBinaryResult> {
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const releaseBaseUrl = validateReleaseBaseUrl(
		options.releaseBaseUrl ?? DEFAULT_AGY_RELEASE_BASE_URL,
	);
	const targetPath = options.targetPath ?? getManagedAgyBinaryPath(platform);
	const installDir = path.dirname(targetPath);
	const fetchText = options.fetchText ?? defaultFetchText;
	const downloadToFile = options.downloadToFile ?? defaultDownloadToFile;
	const extractTarGz = options.extractTarGz ?? defaultExtractTarGz;

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
					`Could not find agy executable inside downloaded archive`,
				);
			}
			binaryToPromote = found;
		}

		options.onProgress?.({
			phase: 'installing',
			message: `Installing Antigravity backend v${manifest.version}...`,
		});

		await promoteBinarySafely(binaryToPromote, targetPath, platform);
		await writeVersionSidecar(
			targetPath,
			manifest.version,
			releaseBaseUrl,
			binaryInfo.sha512,
		);

		return {
			binaryPath: targetPath,
			downloaded: true,
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
 * Ensures an `agy` binary is available on disk, downloading and verifying it
 * into `~/.gemini/bin/agy` automatically when not already installed.
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

	if (isExistingAvailable) {
		const existing = isExistingAvailable(customPath);
		if (existing) {
			return { binaryPath: existing, downloaded: false };
		}
	} else {
		const managed =
			options.targetPath ?? getManagedAgyBinaryPath(options.platform);
		if (fs.existsSync(managed)) {
			return { binaryPath: managed, downloaded: false };
		}
	}

	const dedupeKey =
		options.targetPath ?? getManagedAgyBinaryPath(options.platform);
	const existingFlight = inFlightDownloads.get(dedupeKey);
	if (existingFlight) {
		return existingFlight;
	}

	const task = downloadAndInstallAgyBinary(options).finally(() => {
		inFlightDownloads.delete(dedupeKey);
	});
	inFlightDownloads.set(dedupeKey, task);
	return task;
}
