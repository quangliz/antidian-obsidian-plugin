import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as tls from 'tls';

export const LINUX_SYSTEM_CA_PATHS = [
	'/etc/ssl/certs/ca-certificates.crt',
	'/etc/pki/tls/certs/ca-bundle.crt',
	'/etc/ssl/ca-bundle.pem',
	'/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
];
export const MACOS_SYSTEM_CA_PATH = '/etc/ssl/cert.pem';

export const LINUX_X64_REQUIRED_CPU_FLAGS = [
	'sse4_1',
	'sse4_2',
	'ssse3',
	'popcnt',
	'cx16',
	'avx',
	'avx2',
	'bmi1',
	'bmi2',
	'fma',
];

export const POSIX_SIGILL_EXIT_CODE = 132;
export const SUSPEND_DRIFT_THRESHOLD_MS = 15_000;
export const MAX_STDERR_TAIL_LINES = 20;
export const MAX_STDERR_TAIL_CHARS = 4_000;
export const MAX_CLI_LOG_READ_BYTES = 16_384;
export const CLI_LOG_FRESHNESS_SLACK_MS = 2_000;

export interface LinuxX64CpuSupportResult {
	supported: boolean;
	missingFlags: string[];
	modelName?: string;
}

export type ProcessFailureCategory =
	| 'killed_by_SIGILL'
	| 'unsupported_cpu'
	| 'dll_init_failed'
	| 'permission_denied'
	| 'disk_full'
	| 'file_busy'
	| 'binary_not_found'
	| 'timeout'
	| 'windows_process_terminated'
	| 'access_violation'
	| 'stack_overflow'
	| 'process_exit_zero'
	| 'process_exit_nonzero'
	| 'unexpected_failure'
	| `killed_by_${string}`;

function expandHome(rawPath: string, homeDir: string = os.homedir()): string {
	const trimmed = rawPath.trim();
	if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
		return path.join(homeDir, trimmed.slice(2));
	}
	return trimmed;
}

export function resolveSystemCaBundlePath(
	platform: NodeJS.Platform = process.platform,
	fsExists: (p: string) => boolean = fs.existsSync,
): string | undefined {
	if (platform === 'darwin') {
		return fsExists(MACOS_SYSTEM_CA_PATH) ? MACOS_SYSTEM_CA_PATH : undefined;
	}
	if (platform === 'linux') {
		return LINUX_SYSTEM_CA_PATHS.find((p) => fsExists(p));
	}
	return undefined;
}

export function loadTrustedCaCertificates(
	caCertificatePath?: string,
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const candidatePaths = new Set<string>();
	for (const raw of [
		caCertificatePath,
		env.AGY_CA_CERT,
		env.AGY_LLM_GATEWAY_CA_CERT,
		env.NODE_EXTRA_CA_CERTS,
	]) {
		if (typeof raw === 'string' && raw.trim()) {
			candidatePaths.add(expandHome(raw));
		}
	}

	const extraCerts: string[] = [];
	for (const filePath of candidatePaths) {
		try {
			const content = fs.readFileSync(filePath, 'utf8');
			const blocks = content
				.split(/(?=-----BEGIN CERTIFICATE-----)/g)
				.map((s) => s.trim())
				.filter((s) => s.startsWith('-----BEGIN CERTIFICATE-----'));
			extraCerts.push(...blocks);
		} catch {
			// Ignore unreadable CA paths
		}
	}

	return Array.from(new Set([...tls.rootCertificates, ...extraCerts]));
}

export interface BuildAgySecurityEnvOptions {
	caCertificates?: string;
	extraBinDirs?: string[];
	platform?: NodeJS.Platform;
	fsExists?: (p: string) => boolean;
}

/**
 * Builds child-process environment for `agy` with system/custom CA bundles
 * and PATH entries, mirroring the Antigravity VS Code extension.
 */
export function buildAgySecurityEnv(
	baseEnv: NodeJS.ProcessEnv = process.env,
	options: BuildAgySecurityEnvOptions = {},
): NodeJS.ProcessEnv {
	const platform = options.platform ?? process.platform;
	const fsExists = options.fsExists ?? fs.existsSync;
	const env: NodeJS.ProcessEnv = { ...baseEnv };

	const configuredCa = options.caCertificates?.trim()
		? expandHome(options.caCertificates)
		: undefined;
	if (configuredCa && fsExists(configuredCa)) {
		env.AGY_CA_CERT = configuredCa;
		env.AGY_LLM_GATEWAY_CA_CERT = configuredCa;
		env.NODE_EXTRA_CA_CERTS = configuredCa;
	}

	const systemCa = resolveSystemCaBundlePath(platform, fsExists);
	if (systemCa) {
		if (!env.NODE_EXTRA_CA_CERTS) {
			env.NODE_EXTRA_CA_CERTS = systemCa;
		}
		if (!env.SSL_CERT_FILE) {
			env.SSL_CERT_FILE = systemCa;
		}
	}

	if (!env.NODE_USE_SYSTEM_CA && (platform === 'darwin' || platform === 'win32')) {
		env.NODE_USE_SYSTEM_CA = '1';
	}

	if (options.extraBinDirs && options.extraBinDirs.length > 0) {
		const parts = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
		for (const dir of [...options.extraBinDirs].reverse()) {
			if (dir && !parts.includes(dir)) {
				parts.unshift(dir);
			}
		}
		env.PATH = parts.join(path.delimiter);
	}

	return env;
}

export function checkLinuxX64CpuSupport(options?: {
	platform?: NodeJS.Platform;
	arch?: string;
	readCpuInfo?: () => string;
}): LinuxX64CpuSupportResult {
	const platform = options?.platform ?? process.platform;
	const arch = options?.arch ?? process.arch;
	if (platform !== 'linux' || arch !== 'x64') {
		return { supported: true, missingFlags: [] };
	}

	let cpuInfo: string;
	try {
		cpuInfo = options?.readCpuInfo
			? options.readCpuInfo()
			: fs.readFileSync('/proc/cpuinfo', 'utf8');
	} catch {
		return { supported: true, missingFlags: [] };
	}

	const flagsMatch = /^[ \t]*flags[ \t]*:[ \t]*(.+)$/im.exec(cpuInfo);
	if (!flagsMatch?.[1]) {
		return { supported: true, missingFlags: [] };
	}

	const modelMatch = /^[ \t]*model name[ \t]*:[ \t]*(.+)$/im.exec(cpuInfo);
	const modelName = modelMatch?.[1]?.trim() || undefined;
	const present = new Set(
		flagsMatch[1].trim().toLowerCase().split(/\s+/).filter(Boolean),
	);
	const missingFlags = LINUX_X64_REQUIRED_CPU_FLAGS.filter(
		(flag) => !present.has(flag),
	);

	return {
		supported: missingFlags.length === 0,
		missingFlags,
		modelName,
	};
}

export function isWindowsDllInitCode(code: unknown): boolean {
	if (typeof code !== 'number' || !Number.isInteger(code)) return false;
	const unsigned = code >>> 0;
	return unsigned === 3221225781 || unsigned === 3221225794;
}

export function categorizeExitCode(code: number): ProcessFailureCategory {
	if (code === 0) return 'process_exit_zero';
	const unsigned = code >>> 0;
	if (unsigned === 1073807364 || unsigned === 3221225786) {
		return 'windows_process_terminated';
	}
	if (unsigned === 3221225477) return 'access_violation';
	if (unsigned === 3221225725) return 'stack_overflow';
	if (isWindowsDllInitCode(code)) return 'dll_init_failed';
	return 'process_exit_nonzero';
}

export function categorizeProcessFailure(opts: {
	exitCode?: number | null;
	signal?: string | null;
	stderrTail?: string;
	error?: unknown;
}): ProcessFailureCategory {
	const stderr = opts.stderrTail ?? '';
	const errMsg =
		opts.error instanceof Error
			? opts.error.message
			: typeof opts.error === 'string'
				? opts.error
				: '';

	if (
		opts.signal === 'SIGILL' ||
		opts.exitCode === POSIX_SIGILL_EXIT_CODE ||
		/\bSIGILL\b|illegal instruction/i.test(stderr) ||
		/\bSIGILL\b|illegal instruction/i.test(errMsg)
	) {
		return 'killed_by_SIGILL';
	}

	if (
		/only be run on AMD64 processors with v\d+ microarchitecture support/i.test(
			stderr,
		)
	) {
		return 'unsupported_cpu';
	}

	if (opts.signal) {
		return `killed_by_${opts.signal}`;
	}

	if (opts.exitCode !== undefined && opts.exitCode !== null) {
		return categorizeExitCode(opts.exitCode);
	}

	const errCode =
		typeof opts.error === 'object' && opts.error !== null && 'code' in opts.error
			? String((opts.error as { code?: unknown }).code)
			: undefined;
	if (errCode === 'ENOENT') return 'binary_not_found';
	if (errCode === 'EACCES' || errCode === 'EPERM') return 'permission_denied';
	if (errCode === 'ENOSPC') return 'disk_full';
	if (errCode === 'EBUSY' || errCode === 'ETXTBSY') return 'file_busy';
	if (errCode === 'ETIMEDOUT') return 'timeout';

	return 'unexpected_failure';
}

export function isNonRetriableFailure(
	category: ProcessFailureCategory,
): boolean {
	return (
		category === 'killed_by_SIGILL' ||
		category === 'unsupported_cpu' ||
		category === 'dll_init_failed' ||
		category === 'binary_not_found' ||
		category === 'permission_denied'
	);
}

export function formatProcessExitError(opts: {
	exitCode?: number | null;
	signal?: string | null;
	stderrTail?: string;
	cpuCheck?: LinuxX64CpuSupportResult;
}): string {
	const category = categorizeProcessFailure(opts);

	if (category === 'killed_by_SIGILL' || category === 'unsupported_cpu') {
		const cpu = opts.cpuCheck ?? checkLinuxX64CpuSupport();
		const missing =
			cpu.missingFlags.length > 0
				? ` (missing flags: ${cpu.missingFlags.join(', ')})`
				: '';
		const model = cpu.modelName ? ` [${cpu.modelName}]` : '';
		return `Antigravity backend cannot run on this CPU${model}: requires x86-64-v3 (AVX2/BMI2/FMA)${missing}.`;
	}

	if (category === 'dll_init_failed') {
		return 'Antigravity backend failed to initialize a required Windows DLL (0xC0000142/0xC0000135). Reinstall or repair Visual C++ Redistributable.';
	}

	const base = opts.signal
		? `Antigravity ACP process terminated by signal ${opts.signal}`
		: `Antigravity ACP process exited (code ${opts.exitCode ?? 'unknown'})`;
	const detail = opts.stderrTail?.trim();
	return detail ? `${base}: ${detail.split('\n').slice(-3).join(' | ')}` : base;
}

export function wasSuspendedSince(
	startWallMs: number,
	startUptimeMs: number,
	nowWallMs: number = Date.now(),
	nowUptimeMs: number = process.uptime() * 1000,
): boolean {
	const wallElapsed = nowWallMs - startWallMs;
	const uptimeElapsed = nowUptimeMs - startUptimeMs;
	return Math.abs(wallElapsed - uptimeElapsed) > SUSPEND_DRIFT_THRESHOLD_MS;
}

function readTailLines(filePath: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, 'r');
		const stats = fs.fstatSync(fd);
		if (stats.size <= 0) return undefined;
		const readLen = Math.min(stats.size, MAX_CLI_LOG_READ_BYTES);
		const offset = stats.size - readLen;
		const buf = Buffer.alloc(readLen);
		const bytesRead = fs.readSync(fd, buf, 0, readLen, offset);
		if (bytesRead <= 0) return undefined;
		const rawLines = buf.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);
		const lines = (offset > 0 && rawLines.length > 1 ? rawLines.slice(1) : rawLines)
			.filter((l) => l.trim().length > 0);
		if (lines.length === 0) return undefined;
		return lines.slice(-MAX_STDERR_TAIL_LINES).join('\n').slice(-MAX_STDERR_TAIL_CHARS);
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// Ignore close errors
			}
		}
	}
}

/**
 * Reads the tail of the freshest `cli.log` written since `sinceMs` when stderr
 * captured no diagnostic output.
 */
export function readCliLogTailFallback(
	sinceMs: number,
	appDataDir: string = 'antigravity-anti-dian',
	homeDir: string = os.homedir(),
): string | undefined {
	const dirs = [
		path.join(homeDir, '.gemini', appDataDir),
		path.join(homeDir, '.gemini', appDataDir, 'cli'),
		path.join(homeDir, '.gemini', 'antigravity'),
		path.join(homeDir, '.gemini', 'antigravity', 'cli'),
	];
	const threshold = sinceMs - CLI_LOG_FRESHNESS_SLACK_MS;
	let newestPath: string | undefined;
	let newestMtime = -1;

	for (const dir of dirs) {
		const candidates = [path.join(dir, 'cli.log')];
		try {
			for (const entry of fs.readdirSync(path.join(dir, 'log'))) {
				if (entry.startsWith('cli-') && entry.endsWith('.log')) {
					candidates.push(path.join(dir, 'log', entry));
				}
			}
		} catch {
			// Log subdir may not exist
		}

		for (const filePath of candidates) {
			try {
				const st = fs.statSync(filePath);
				if (st.isFile() && st.size > 0 && st.mtimeMs >= threshold && st.mtimeMs > newestMtime) {
					newestMtime = st.mtimeMs;
					newestPath = filePath;
				}
			} catch {
				// Ignore missing files
			}
		}
	}

	return newestPath ? readTailLines(newestPath) : undefined;
}
