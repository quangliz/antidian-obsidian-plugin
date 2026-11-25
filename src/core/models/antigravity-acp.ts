import { spawn, ChildProcess } from 'child_process';
import type { ReplayedAgentEvent, ReplayedMessage } from '../types/sessions';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import {
	setTimeout as nodeSetTimeout,
	clearTimeout as nodeClearTimeout,
} from 'timers';
import type { MediaInput, TokenUsage } from '../types/model';
import type {
	ElicitationHandler,
	ElicitationResponse,
} from '../types/elicitation';
import type { PlanStep } from '../types/plan';
import { parseElicitationRequest } from './elicitation';
import { parseFocusText, parsePlanSteps } from './plan';
import {
	type BinaryDownloadProgress,
	type EnsureAgyBinaryResult,
	ensureAgyBinary,
	getManagedAgyBinaryPath,
} from './agy-binary-manager';
import {
	MAX_STDERR_TAIL_LINES,
	buildAgySecurityEnv,
	categorizeProcessFailure,
	formatProcessExitError,
	isNonRetriableFailure,
	readCliLogTailFallback,
	wasSuspendedSince,
} from './agy-diagnostics';
import type { McpToolServer } from './mcp-tool-server';

export interface AvailableModel {
	id: string;
	displayName: string;
	maxTokens?: number;
	maxOutputTokens?: number;
	supportsThinking?: boolean;
}

export interface ModelVariant {
	id: string;
	thinkingEffort: string;
	displayName: string;
}

export interface ModelGroup {
	baseName: string;
	maxTokens?: number;
	supportsThinking?: boolean;
	variants: ModelVariant[];
}

export interface AvailableModelsResponse {
	models: AvailableModel[];
	groups: ModelGroup[];
	defaultModelId?: string;
}

export interface AccountTierInfo {
	tierId?: string;
	tierName?: string;
	upgradeUri?: string;
}

export interface QuotaBucketInfo {
	id: string;
	name: string;
	description?: string;
	window?: string;
	remainingFraction: number;
	resetTime?: string;
}

export interface QuotaGroupInfo {
	name: string;
	description?: string;
	buckets: QuotaBucketInfo[];
}

export interface UserQuotaResponse {
	groups: QuotaGroupInfo[];
	accountTier?: AccountTierInfo | null;
}

export interface ContextWindowUsage {
	used: number;
	size: number;
}

export interface CachedProviderMetadata {
	models?: AvailableModel[];
	defaultModelId?: string;
	accountTier?: AccountTierInfo | null;
	quota?: {
		groups: QuotaGroupInfo[];
		fetchedAt: number;
	};
}

export interface CachedQuotaSnapshot {
	data: UserQuotaResponse;
	fetchedAt: number;
	isStale: boolean;
}

export interface AcpStreamCallbacks {
	onThoughtDelta?: (text: string) => void;
	onAnswerDelta?: (text: string) => void;
	onToolStart?: (
		toolName: string,
		toolArgs: Record<string, unknown>,
		callId?: string,
	) => void;
	onToolEnd?: (toolName: string, toolOutput: unknown, callId?: string) => void;
	/** Handles interactive ACP `elicitation/create` form prompts (e.g. `ask_question`). */
	onElicitation?: ElicitationHandler;
	/** Called when the agent publishes or updates its live step checklist. */
	onPlanUpdate?: (steps: PlanStep[]) => void;
	/** Called when the agent publishes a high-level focus status phrase. */
	onFocusUpdate?: (focus: string) => void;
}

export interface AcpPromptResult {
	answer: string;
	stopReason?: string;
	usage?: TokenUsage;
}

export interface AntigravityAcpOptions {
	cliPath?: string;
	caCertificates?: string;
	cwd?: string;
	model?: string;
	systemPrompt?: string;
	mcpToolServer?: McpToolServer;
	/**
	 * Subdirectory of `~/.gemini` where `agy acp` stores conversations,
	 * brain artifacts, and logs. Defaults to a dedicated directory so
	 * Anti-dian sessions do not appear in the user's `agy` CLI `/resume`
	 * list. Authentication is shared across data dirs.
	 */
	appDataDir?: string;
	/** Persisted models/tier/quota snapshot for instant startup rendering. */
	initialCache?: CachedProviderMetadata;
	/** Called when models, tier, or quota are refreshed from the backend. */
	onCacheUpdate?: (cache: CachedProviderMetadata) => void;
	/** Injectable quota fetcher for unit tests. */
	quotaFetcher?: () => Promise<UserQuotaResponse | null>;
}

/** A stored conversation as reported by ACP `session/list`. */
export interface AcpSessionSummary {
	sessionId: string;
	title?: string;
	/** ISO timestamp of the last update, when the CLI reports one. */
	updatedAt?: string;
}

export type {
	ReplayedAgentEvent,
	ReplayedMessage,
} from '../types/sessions';

/** Pages of `session/list` to follow before giving up (guards a looping cursor). */
const MAX_SESSION_LIST_PAGES = 10;

/** How long cached quota is considered fresh before revalidating in background. */
export const QUOTA_FRESH_TTL_MS = 120_000;

const AUTO_RECOVER_MAX_ATTEMPTS = 3;
const AUTO_RECOVER_WINDOW_MS = 10 * 60_000;
const AUTO_RECOVER_BACKOFF_MS = [1_000, 3_000, 9_000];

/** Dedicated agy data dir that keeps Anti-dian sessions out of the CLI history. */
export const ANTI_DIAN_APP_DATA_DIR = 'antigravity-anti-dian';

const MCP_SERVER_NAME = 'anti-dian-vault';
const MCP_TOOL_PREFIX = `mcp_${MCP_SERVER_NAME}_`;

const SAFE_BUILTIN_TOOLS = new Set([
	'search_web',
	'web_search',
	'google_search',
	'ask_question',
	'update_steps',
	'update_focus',
]);

/** Built-in progress/tracking tools rendered as live plan/focus UI rather than trace rows. */
const PROGRESS_BUILTIN_TOOLS = new Set(['update_steps', 'update_focus']);

export function formatTokens(tokens?: number): string {
	if (!tokens) return '';
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
	}
	if (tokens >= 1000) {
		return `${Math.round(tokens / 1000)}k`;
	}
	return `${tokens}`;
}

export function groupModels(models: AvailableModel[]): ModelGroup[] {
	const groups = new Map<string, ModelGroup>();

	for (const m of models) {
		let baseName = m.displayName;
		let effort = 'Default';

		const match = m.displayName.match(
			/^(.*?)\s*\((High|Low|Off|Medium|XHigh|Max|Thinking)\)$/i,
		);
		if (match && match[1] && match[2]) {
			baseName = match[1].trim();
			const rawEffort = match[2].toLowerCase();
			effort =
				rawEffort === 'xhigh'
					? 'XHigh'
					: rawEffort.charAt(0).toUpperCase() + rawEffort.slice(1);
		} else if (m.id.endsWith('-xhigh')) {
			baseName = m.displayName.replace(/\s*\(XHigh\)/i, '').trim();
			effort = 'XHigh';
		} else if (m.id.endsWith('-high')) {
			baseName = m.displayName.replace(/\s*\(High\)/i, '').trim();
			effort = 'High';
		} else if (m.id.endsWith('-medium')) {
			baseName = m.displayName.replace(/\s*\(Medium\)/i, '').trim();
			effort = 'Medium';
		} else if (m.id.endsWith('-low')) {
			baseName = m.displayName.replace(/\s*\(Low\)/i, '').trim();
			effort = 'Low';
		} else if (m.id.endsWith('-off')) {
			baseName = m.displayName.replace(/\s*\(Off\)/i, '').trim();
			effort = 'Off';
		} else if (m.supportsThinking) {
			effort = 'Thinking';
		}

		let group = groups.get(baseName);
		if (!group) {
			group = {
				baseName,
				maxTokens: m.maxTokens,
				supportsThinking: m.supportsThinking,
				variants: [],
			};
			groups.set(baseName, group);
		}
		if (m.maxTokens && !group.maxTokens) {
			group.maxTokens = m.maxTokens;
		}
		if (m.supportsThinking) {
			group.supportsThinking = true;
		}
		group.variants.push({
			id: m.id,
			thinkingEffort: effort,
			displayName: m.displayName,
		});
	}

	return Array.from(groups.values());
}

export function resolveAgyBinary(customPath?: string): string {
	if (customPath && customPath.trim()) {
		return customPath.trim();
	}

	const binName = process.platform === 'win32' ? 'agy.exe' : 'agy';
	const candidates = [
		getManagedAgyBinaryPath(),
		path.join(os.homedir(), '.local', 'bin', binName),
		'/usr/local/bin/agy',
		'/opt/homebrew/bin/agy',
	];

	for (const candidate of candidates) {
		try {
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		} catch {
			// Ignore inaccessible paths
		}
	}

	return binName;
}

export function isAgyBinaryAvailable(customPath?: string): boolean {
	const bin = resolveAgyBinary(customPath);
	if (bin.includes(path.sep) || bin.includes('/')) {
		try {
			return fs.existsSync(bin);
		} catch {
			return false;
		}
	}

	const pathDirs = (process.env.PATH ?? '').split(path.delimiter);
	for (const dir of pathDirs) {
		if (!dir) continue;
		const full = path.join(dir, bin);
		try {
			if (fs.existsSync(full)) {
				return true;
			}
		} catch {
			// Ignore
		}
	}
	return false;
}

export function findExistingAgyBinary(customPath?: string): string | null {
	return isAgyBinaryAvailable(customPath)
		? resolveAgyBinary(customPath)
		: null;
}

interface PendingRpc {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
}

interface AcpSessionNewResult {
	sessionId: string;
	models?: {
		availableModels?: { modelId: string; name?: string }[];
		currentModelId?: string;
	};
	_meta?: {
		antigravity?: {
			tier?: {
				id?: string;
				name?: string;
				upgradeUri?: string;
			};
		};
	};
}

interface AcpPromptResponse {
	stopReason?: string;
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		totalTokens?: number;
		thoughtTokens?: number;
		cachedReadTokens?: number;
		cachedWriteTokens?: number;
	};
}

/** Untrusted JSON from the CLI: keep only finite, non-negative numbers. */
const tokenCount = (v: unknown): number | undefined =>
	typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

export class AntigravityAcpClient {
	private cliPath?: string;
	private caCertificates?: string;
	private cwd: string;
	private model?: string;
	private systemPrompt?: string;
	private mcpToolServer?: McpToolServer;
	private appDataDir: string;

	private proc: ChildProcess | null = null;
	private intentionalStop = false;
	private procSpawnedAtWallMs = 0;
	private procSpawnedAtUptimeMs = 0;
	private stderrTail: string[] = [];
	private recoveryAttemptTimestamps: number[] = [];
	private recoveryTimer: ReturnType<typeof nodeSetTimeout> | null = null;
	private rl: readline.Interface | null = null;
	private nextId = 1;
	private pending = new Map<number, PendingRpc>();
	private initialized = false;
	private sessionId: string | null = null;
	private activeModelId: string | null = null;

	private cachedModels: AvailableModelsResponse | null = null;
	private cachedTier: AccountTierInfo | null = null;
	private cachedQuota: { data: UserQuotaResponse; fetchedAt: number } | null =
		null;
	private quotaFetchPromise: Promise<UserQuotaResponse | null> | null = null;
	private onCacheUpdate?: (cache: CachedProviderMetadata) => void;
	private quotaFetcher?: () => Promise<UserQuotaResponse | null>;
	private contextUsage: ContextWindowUsage | null = null;
	private activeCallbacks: AcpStreamCallbacks | null = null;
	private activeAnswerChunks: string[] = [];
	private activeToolNames = new Map<string, string>();
	private activeElicitationCancels = new Set<() => void>();
	private elicitationOutcomes = new Map<string, Record<string, unknown>>();
	private startPromise: Promise<void> | null = null;
	private sessionTitle: string | null = null;
	private sessionInfoListeners = new Set<() => void>();
	/** Collects `session/load` history replay; null outside a load. */
	private replayBuffer: ReplayedMessage[] | null = null;
	private promptInFlight = false;
	private turnCancelled = false;
	private activePromptRpcId: number | null = null;
	private cancelFallbackTimer: ReturnType<typeof nodeSetTimeout> | null = null;

	constructor(options: AntigravityAcpOptions = {}) {
		this.cliPath = options.cliPath;
		this.caCertificates = options.caCertificates;
		this.cwd = options.cwd ?? process.cwd();
		this.model = options.model;
		this.systemPrompt = options.systemPrompt;
		this.mcpToolServer = options.mcpToolServer;
		this.appDataDir = options.appDataDir ?? ANTI_DIAN_APP_DATA_DIR;
		this.onCacheUpdate = options.onCacheUpdate;
		this.quotaFetcher = options.quotaFetcher;
		if (options.initialCache) {
			this.hydrateCache(options.initialCache);
		}
	}

	setCaCertificates(caCertificates?: string): void {
		const next = caCertificates?.trim() || undefined;
		if (this.caCertificates !== next) {
			this.caCertificates = next;
			this.destroyProcess();
		}
	}

	private hydrateCache(cache: CachedProviderMetadata): void {
		if (Array.isArray(cache.models) && cache.models.length > 0) {
			this.cachedModels = {
				models: cache.models,
				groups: groupModels(cache.models),
				defaultModelId: cache.defaultModelId,
			};
		}
		if (cache.accountTier) {
			this.cachedTier = cache.accountTier;
		}
		if (
			cache.quota &&
			Array.isArray(cache.quota.groups) &&
			typeof cache.quota.fetchedAt === 'number'
		) {
			this.cachedQuota = {
				data: {
					groups: cache.quota.groups,
					accountTier: this.cachedTier,
				},
				fetchedAt: cache.quota.fetchedAt,
			};
		}
	}

	private emitCacheUpdate(): void {
		if (!this.onCacheUpdate) return;
		const snapshot: CachedProviderMetadata = {
			models: this.cachedModels?.models,
			defaultModelId: this.cachedModels?.defaultModelId,
			accountTier: this.cachedTier,
			quota: this.cachedQuota
				? {
						groups: this.cachedQuota.data.groups,
						fetchedAt: this.cachedQuota.fetchedAt,
					}
				: undefined,
		};
		try {
			this.onCacheUpdate(snapshot);
		} catch {
			// Cache persistence must never break the transport.
		}
	}

	setCliPath(cliPath?: string): void {
		if (this.cliPath !== cliPath) {
			this.cliPath = cliPath;
			this.destroyProcess();
		}
	}

	setModel(model: string): void {
		this.model = model;
		if (this.sessionId && this.activeModelId !== model) {
			void this.applyModel(model).catch(() => {
				// Will retry on next prompt
			});
		}
	}

	getModel(): string {
		return this.model ?? this.activeModelId ?? 'gemini-3.8-flash-high';
	}

	getAccountTier(): AccountTierInfo | null {
		return this.cachedTier;
	}

	getContextUsage(): ContextWindowUsage | null {
		return this.contextUsage;
	}

	getCachedAvailableModels(): AvailableModelsResponse | null {
		return this.cachedModels;
	}

	getCachedUserQuota(): CachedQuotaSnapshot | null {
		if (!this.cachedQuota) return null;
		const isStale =
			Date.now() - this.cachedQuota.fetchedAt >= QUOTA_FRESH_TTL_MS;
		return {
			data: {
				...this.cachedQuota.data,
				accountTier: this.cachedTier ?? this.cachedQuota.data.accountTier,
			},
			fetchedAt: this.cachedQuota.fetchedAt,
			isStale,
		};
	}

	/**
	 * Starts ACP initialization and background quota prefetch when the binary
	 * is already present on disk, mirroring how the VS Code extension warms up
	 * its backend on activation.
	 */
	warmup(): void {
		if (!isAgyBinaryAvailable(this.cliPath)) return;
		void this.ensureSession().catch(() => {
			// Best-effort warm-up; errors surface when the user interacts.
		});
	}

	/** Triggers a non-blocking background quota refresh when stale or forced. */
	prefetchQuota(force = false): void {
		if (!force && this.cachedQuota) {
			if (Date.now() - this.cachedQuota.fetchedAt < QUOTA_FRESH_TTL_MS) {
				return;
			}
		}
		if (!this.quotaFetcher && !isAgyBinaryAvailable(this.cliPath)) {
			return;
		}
		void this.fetchUserQuota(force).catch(() => {
			// Background prefetch should never surface unhandled rejections.
		});
	}

	async fetchUserQuota(force = false): Promise<UserQuotaResponse | null> {
		const now = Date.now();
		if (
			!force &&
			this.cachedQuota &&
			now - this.cachedQuota.fetchedAt < QUOTA_FRESH_TTL_MS
		) {
			return {
				...this.cachedQuota.data,
				accountTier: this.cachedTier ?? this.cachedQuota.data.accountTier,
			};
		}

		if (this.quotaFetchPromise) {
			return this.quotaFetchPromise;
		}

		const task = this.runQuotaFetch().finally(() => {
			if (this.quotaFetchPromise === task) {
				this.quotaFetchPromise = null;
			}
		});
		this.quotaFetchPromise = task;
		return task;
	}

	private async runQuotaFetch(): Promise<UserQuotaResponse | null> {
		try {
			const data = this.quotaFetcher
				? await this.quotaFetcher()
				: await this.spawnQuotaCommand();
			if (data) {
				const enriched: UserQuotaResponse = {
					...data,
					accountTier: this.cachedTier ?? data.accountTier,
				};
				this.cachedQuota = { data: enriched, fetchedAt: Date.now() };
				this.emitCacheUpdate();
				return enriched;
			}
		} catch {
			// Fall back to cached data below
		}

		if (this.cachedQuota) {
			return {
				...this.cachedQuota.data,
				accountTier: this.cachedTier ?? this.cachedQuota.data.accountTier,
			};
		}
		return this.cachedTier
			? { groups: [], accountTier: this.cachedTier }
			: null;
	}

	private async spawnQuotaCommand(): Promise<UserQuotaResponse | null> {
		const bin = resolveAgyBinary(this.cliPath);
		const stdout = await new Promise<string>((resolve, reject) => {
			const child = spawn(
				bin,
				['--print', '/usage', '--output-format', 'json'],
				{
					cwd: this.cwd,
					stdio: ['ignore', 'pipe', 'pipe'],
					env: this.buildEnv(),
				},
			);

			let out = '';
			child.stdout?.on('data', (chunk: Buffer | string) => {
				out += chunk.toString();
			});
			child.on('error', reject);
			child.on('close', (code) => {
				if (code === 0) resolve(out);
				else reject(new Error(`agy /usage exited with code ${code}`));
			});
		});

		const parsed = JSON.parse(stdout) as {
			command?: {
				data?: {
					groups?: {
						name: string;
						description?: string;
						buckets?: {
							id: string;
							name: string;
							description?: string;
							window?: string;
							remaining_fraction?: number;
							reset_time?: string;
						}[];
					}[];
				};
			};
		};

		const groups: QuotaGroupInfo[] = (
			parsed.command?.data?.groups ?? []
		).map((g) => ({
			name: g.name,
			description: g.description,
			buckets: (g.buckets ?? []).map((b) => ({
				id: b.id,
				name: b.name,
				description: b.description,
				window: b.window,
				remainingFraction: b.remaining_fraction ?? 1,
				resetTime: b.reset_time,
			})),
		}));

		return {
			groups,
			accountTier: this.cachedTier,
		};
	}

	async ensureBinary(
		onProgress?: (progress: BinaryDownloadProgress) => void,
	): Promise<EnsureAgyBinaryResult> {
		return ensureAgyBinary(
			{
				customPath: this.cliPath,
				caCertificates: this.caCertificates,
				onProgress,
			},
			findExistingAgyBinary,
		);
	}

	async checkStatus(
		_onProgress?: (progress: BinaryDownloadProgress) => void,
	): Promise<{
		cliFound: boolean;
		binaryPath?: string;
		authenticated: boolean;
		tier?: AccountTierInfo | null;
		error?: string;
	}> {
		if (!isAgyBinaryAvailable(this.cliPath)) {
			return {
				cliFound: false,
				authenticated: false,
				error: 'Backend not installed yet',
			};
		}
		const binaryPath = resolveAgyBinary(this.cliPath);

		try {
			await this.ensureSession();
			return {
				cliFound: true,
				binaryPath,
				authenticated: true,
				tier: this.cachedTier,
			};
		} catch (err) {
			return {
				cliFound: true,
				binaryPath,
				authenticated: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async login(
		onProgress?: (progress: BinaryDownloadProgress) => void,
	): Promise<void> {
		const { binaryPath: bin } = await this.ensureBinary(onProgress);
		await new Promise<void>((resolve, reject) => {
			const args = ['acp', '--login', ...this.appDataDirArgs()];
			const child = spawn(bin, args, {
				cwd: this.cwd,
				stdio: ['ignore', 'pipe', 'pipe'],
				env: this.buildEnv(),
			});

			let stderr = '';
			child.stderr?.on('data', (chunk: Buffer | string) => {
				stderr += chunk.toString();
			});

			child.on('error', (err) => {
				reject(
					new Error(
						`Failed to launch "${bin} acp --login": ${err.message}`,
					),
				);
			});

			child.on('close', (code) => {
				if (code === 0) {
					this.destroyProcess();
					resolve();
				} else {
					reject(
						new Error(
							`Antigravity login exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`,
						),
					);
				}
			});
		});
	}

	async fetchAvailableModels(): Promise<AvailableModelsResponse> {
		await this.ensureSession();
		if (this.cachedModels) {
			return this.cachedModels;
		}
		return { models: [], groups: [] };
	}

	getSessionId(): string | null {
		return this.sessionId;
	}

	getSessionTitle(): string | null {
		return this.sessionTitle;
	}

	/** Notified when the active session or its CLI-generated title changes. */
	onSessionInfoChange(listener: () => void): () => void {
		this.sessionInfoListeners.add(listener);
		return () => this.sessionInfoListeners.delete(listener);
	}

	/**
	 * Lists stored conversations for this vault (newest first). Only sessions
	 * whose cwd is the vault are returned, so CLI sessions started elsewhere
	 * never leak into the picker.
	 */
	async listSessions(): Promise<AcpSessionSummary[]> {
		await this.ensureInitialized();
		const out: AcpSessionSummary[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < MAX_SESSION_LIST_PAGES; page++) {
			const res = (await this.sendRequest('session/list', {
				cwd: this.cwd,
				...(cursor ? { cursor } : {}),
			})) as { sessions?: unknown; nextCursor?: unknown } | null;
			out.push(...parseSessionList(res?.sessions, this.cwd));
			cursor =
				typeof res?.nextCursor === 'string' && res.nextCursor
					? res.nextCursor
					: undefined;
			if (!cursor) break;
		}
		return sortSessionsNewestFirst(dedupeSessions(out));
	}

	/**
	 * Switches to a stored conversation. The CLI replays its history, which is
	 * returned so the UI can render it; later prompts continue that session.
	 */
	async loadSession(sessionId: string): Promise<ReplayedMessage[]> {
		if (this.promptInFlight) {
			throw new Error('Cannot switch sessions while a response is running.');
		}
		if (this.startPromise) {
			await this.startPromise.catch(() => undefined);
		}
		if (this.sessionId === sessionId) {
			return [];
		}
		await this.resetSession();

		let replayed: ReplayedMessage[] = [];
		const loading = (async () => {
			await this.ensureInitialized();
			this.replayBuffer = [];
			try {
				const res = (await this.sendRequest('session/load', {
					...(await this.buildSessionParams()),
					sessionId,
				})) as Partial<AcpSessionNewResult> | null;
				replayed = this.replayBuffer;
				await this.applySessionResult(sessionId, res ?? {});
			} finally {
				this.replayBuffer = null;
			}
		})();
		this.startPromise = loading;
		try {
			await loading;
		} finally {
			if (this.startPromise === loading) this.startPromise = null;
		}
		return replayed;
	}

	async resetSession(): Promise<void> {
		const hadSession = this.sessionId !== null || this.sessionTitle !== null;
		this.sessionTitle = null;
		if (hadSession) this.emitSessionInfo();
		if (this.sessionId && this.proc && !this.proc.killed) {
			const oldId = this.sessionId;
			this.sessionId = null;
			this.activeModelId = null;
			this.contextUsage = null;
			try {
				await this.sendRequest('session/close', { sessionId: oldId });
			} catch {
				// Ignore close errors
			}
		} else {
			this.sessionId = null;
			this.activeModelId = null;
			this.contextUsage = null;
		}
	}

	cancel(): void {
		if (!this.promptInFlight && !this.startPromise) {
			return;
		}
		this.turnCancelled = true;
		this.cancelActiveElicitations();
		if (this.sessionId && this.proc?.stdin && !this.proc.killed) {
			this.sendNotification('session/cancel', {
				sessionId: this.sessionId,
			});
		}
		// Safety net: if the CLI does not settle the cancelled prompt promptly,
		// tear down the wedged process so the UI unblocks and the next turn starts fresh.
		if (!this.cancelFallbackTimer) {
			const promptId = this.activePromptRpcId;
			this.cancelFallbackTimer = nodeSetTimeout(() => {
				this.cancelFallbackTimer = null;
				if (!this.turnCancelled) return;
				if (promptId !== null && this.pending.has(promptId)) {
					const entry = this.pending.get(promptId)!;
					this.pending.delete(promptId);
					entry.resolve({ stopReason: 'cancelled' });
				}
				if (this.promptInFlight || this.startPromise) {
					this.destroyProcess();
				}
			}, 3000);
		}
	}

	async prompt(
		text: string,
		media?: MediaInput[],
		callbacks?: AcpStreamCallbacks,
		signal?: AbortSignal,
	): Promise<AcpPromptResult> {
		if (signal?.aborted) {
			return { answer: '', stopReason: 'cancelled' };
		}

		this.promptInFlight = true;
		this.turnCancelled = false;
		this.activePromptRpcId = null;
		this.activeCallbacks = callbacks ?? null;
		this.activeAnswerChunks = [];
		this.activeToolNames.clear();
		this.elicitationOutcomes.clear();

		const onAbort = () => this.cancel();
		signal?.addEventListener('abort', onAbort, { once: true });

		try {
			await this.ensureSession();

			if (this.turnCancelled || signal?.aborted) {
				return { answer: '', stopReason: 'cancelled' };
			}

			if (this.model && this.activeModelId !== this.model) {
				await this.applyModel(this.model);
			}

			if (this.turnCancelled || signal?.aborted) {
				return { answer: '', stopReason: 'cancelled' };
			}

			const promptBlocks: Record<string, unknown>[] = [];
			if (text) {
				promptBlocks.push({ type: 'text', text });
			}
			if (media) {
				for (const m of media) {
					if (m.type === 'image' && m.data) {
						const mimeType =
							m.mimeType ??
							(m.data.startsWith('data:')
								? m.data.split(';')[0]?.slice(5) || 'image/png'
								: 'image/png');
						const base64Data = m.data.includes(',')
							? m.data.split(',')[1] || ''
							: m.data;
						promptBlocks.push({
							type: 'image',
							mimeType,
							data: base64Data,
						});
					}
				}
			}

			const result = (await this.sendRequest(
				'session/prompt',
				{
					sessionId: this.sessionId,
					prompt: promptBlocks,
				},
				(id) => {
					this.activePromptRpcId = id;
				},
			)) as AcpPromptResponse;

			const usage: TokenUsage | undefined = result?.usage
				? {
						promptTokens: tokenCount(result.usage.inputTokens),
						candidatesTokens: tokenCount(result.usage.outputTokens),
						totalTokens: tokenCount(result.usage.totalTokens),
						thoughtTokens: tokenCount(result.usage.thoughtTokens),
						cachedReadTokens: tokenCount(result.usage.cachedReadTokens),
						cachedWriteTokens: tokenCount(result.usage.cachedWriteTokens),
					}
				: undefined;

			const partial = this.activeAnswerChunks.join('').trim();
			const cancelled =
				this.turnCancelled ||
				signal?.aborted === true ||
				result?.stopReason === 'cancelled';

			if (!cancelled) {
				this.prefetchQuota(true);
			}

			return {
				answer: cancelled
					? partial
					: partial || '(No response text generated)',
				stopReason: cancelled ? 'cancelled' : result?.stopReason,
				usage,
			};
		} catch (err) {
			if (this.turnCancelled || signal?.aborted) {
				return {
					answer: this.activeAnswerChunks.join('').trim(),
					stopReason: 'cancelled',
				};
			}
			throw err;
		} finally {
			signal?.removeEventListener('abort', onAbort);
			if (this.cancelFallbackTimer) {
				nodeClearTimeout(this.cancelFallbackTimer);
				this.cancelFallbackTimer = null;
			}
			this.promptInFlight = false;
			this.turnCancelled = false;
			this.activePromptRpcId = null;
			this.activeCallbacks = null;
			this.activeAnswerChunks = [];
			this.activeToolNames.clear();
			this.elicitationOutcomes.clear();
			this.cancelActiveElicitations();
		}
	}

	async destroy(): Promise<void> {
		await this.resetSession();
		this.destroyProcess();
		if (this.mcpToolServer) {
			await this.mcpToolServer.stop();
		}
	}

	private async ensureSession(): Promise<void> {
		if (this.proc && !this.proc.killed && this.initialized && this.sessionId) {
			return;
		}

		if (this.startPromise) {
			return this.startPromise;
		}

		this.startPromise = this.startAndCreateSession();
		try {
			await this.startPromise;
		} finally {
			this.startPromise = null;
		}
	}

	private async ensureInitialized(): Promise<void> {
		if (!this.proc || this.proc.killed) {
			await this.ensureBinary();
			this.spawnProcess();
		}

		if (!this.initialized) {
			await this.sendRequest('initialize', {
				protocolVersion: 1,
				clientCapabilities: {
					elicitation: {
						form: {},
					},
				},
				clientInfo: {
					name: 'anti-dian',
					version: '1.0.0',
				},
			});
			this.initialized = true;
		}
	}

	/** Shared `session/new` / `session/load` params: vault cwd, MCP server, system prompt. */
	private async buildSessionParams(): Promise<Record<string, unknown>> {
		const mcpServers: Record<string, unknown>[] = [];
		if (this.mcpToolServer) {
			const info = await this.mcpToolServer.start();
			mcpServers.push({
				type: 'http',
				name: MCP_SERVER_NAME,
				url: info.url,
				headers: [
					{
						name: 'Authorization',
						value: `Bearer ${info.token}`,
					},
				],
			});
		}

		const params: Record<string, unknown> = {
			cwd: this.cwd,
			mcpServers,
		};

		if (this.systemPrompt) {
			params._meta = {
				antigravity: {
					systemPrompt: {
						append: this.systemPrompt,
					},
				},
			};
		}
		return params;
	}

	private async startAndCreateSession(): Promise<void> {
		await this.ensureInitialized();

		if (!this.sessionId) {
			const sess = (await this.sendRequest(
				'session/new',
				await this.buildSessionParams(),
			)) as AcpSessionNewResult;
			await this.applySessionResult(sess.sessionId, sess);
		}
	}

	private async applySessionResult(
		sessionId: string,
		sess: Partial<AcpSessionNewResult>,
	): Promise<void> {
		this.sessionId = sessionId;
		this.activeModelId = sess.models?.currentModelId ?? null;

		const rawModels = sess.models?.availableModels ?? [];
		if (rawModels.length > 0 || !this.cachedModels) {
			const models: AvailableModel[] = rawModels.map((m) => ({
				id: m.modelId,
				displayName: m.name || m.modelId,
			}));

			this.cachedModels = {
				models,
				groups: groupModels(models),
				defaultModelId: sess.models?.currentModelId,
			};
		}

		const tier = sess._meta?.antigravity?.tier;
		if (tier) {
			this.cachedTier = {
				tierId: tier.id,
				tierName: tier.name,
				upgradeUri: tier.upgradeUri,
			};
		}

		if (this.model && this.activeModelId !== this.model) {
			try {
				await this.applyModel(this.model);
			} catch {
				// If saved model is no longer available, keep session default
				this.model = this.activeModelId ?? undefined;
			}
		}
		this.emitCacheUpdate();
		this.prefetchQuota();
		this.emitSessionInfo();
	}

	private emitSessionInfo(): void {
		for (const listener of this.sessionInfoListeners) {
			try {
				listener();
			} catch {
				// A broken listener must not break the transport.
			}
		}
	}

	private async applyModel(modelId: string): Promise<void> {
		if (!this.sessionId) return;
		await this.sendRequest('session/set_model', {
			sessionId: this.sessionId,
			modelId,
		});
		this.activeModelId = modelId;
	}

	private appDataDirArgs(): string[] {
		return ['--app-data-dir', this.appDataDir];
	}

	private buildEnv(): NodeJS.ProcessEnv {
		return buildAgySecurityEnv(process.env, {
			caCertificates: this.caCertificates,
			extraBinDirs: [
				path.dirname(getManagedAgyBinaryPath()),
				path.join(os.homedir(), '.local', 'bin'),
			],
		});
	}

	private scheduleAutoRecovery(reason: string): void {
		if (this.intentionalStop || this.recoveryTimer) return;
		const now = Date.now();
		if (
			this.procSpawnedAtWallMs > 0 &&
			wasSuspendedSince(this.procSpawnedAtWallMs, this.procSpawnedAtUptimeMs)
		) {
			this.recoveryAttemptTimestamps = [];
		}
		this.recoveryAttemptTimestamps = this.recoveryAttemptTimestamps.filter(
			(ts) => now - ts < AUTO_RECOVER_WINDOW_MS,
		);
		const attempt = this.recoveryAttemptTimestamps.length + 1;
		if (attempt > AUTO_RECOVER_MAX_ATTEMPTS) return;

		this.recoveryAttemptTimestamps.push(now);
		const baseDelay =
			AUTO_RECOVER_BACKOFF_MS[
				Math.min(attempt - 1, AUTO_RECOVER_BACKOFF_MS.length - 1)
			] ?? 9_000;

		const timer = nodeSetTimeout(() => {
			this.recoveryTimer = null;
			if (this.intentionalStop || this.proc) return;
			void this.ensureInitialized().catch(() => {
				// Errors surface on next user action; avoid unhandled rejection
			});
		}, baseDelay);
		timer.unref?.();
		this.recoveryTimer = timer;
		void reason;
	}

	private spawnProcess(): void {
		const bin = resolveAgyBinary(this.cliPath);
		this.intentionalStop = false;
		this.stderrTail = [];
		this.procSpawnedAtWallMs = Date.now();
		this.procSpawnedAtUptimeMs = process.uptime() * 1000;

		const proc = spawn(bin, ['acp', ...this.appDataDirArgs()], {
			cwd: this.cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: this.buildEnv(),
		});
		this.proc = proc;

		proc.stderr?.on('data', (chunk: Buffer | string) => {
			const lines = chunk
				.toString()
				.split(/\r?\n/)
				.map((l) => l.trim())
				.filter(Boolean);
			for (const line of lines) {
				this.stderrTail.push(line);
				if (this.stderrTail.length > MAX_STDERR_TAIL_LINES) {
					this.stderrTail.shift();
				}
			}
		});

		proc.on('error', (err) => {
			this.rejectAllPending(
				new Error(`Failed to start Antigravity CLI (${bin}): ${err.message}`),
			);
			this.destroyProcess();
		});

		proc.on('exit', (code, signal) => {
			const wasIntentional = this.intentionalStop;
			let tail =
				this.stderrTail.length > 0 ? this.stderrTail.join('\n') : undefined;
			if (!wasIntentional && !tail) {
				tail = readCliLogTailFallback(
					this.procSpawnedAtWallMs,
					this.appDataDir,
				);
			}

			const category = categorizeProcessFailure({
				exitCode: code,
				signal,
				stderrTail: tail,
			});
			const message = formatProcessExitError({
				exitCode: code,
				signal,
				stderrTail: tail,
			});

			this.rejectAllPending(new Error(message));
			if (this.proc === proc) {
				this.proc = null;
				this.rl = null;
				this.initialized = false;
				this.sessionId = null;
				this.activeModelId = null;
			}

			if (!wasIntentional && !isNonRetriableFailure(category)) {
				this.scheduleAutoRecovery(category);
			}
		});

		if (proc.stdout) {
			this.rl = readline.createInterface({ input: proc.stdout });
			this.rl.on('line', (line) => {
				this.handleLine(line);
			});
		}
	}

	private destroyProcess(): void {
		this.intentionalStop = true;
		this.cancelActiveElicitations();
		if (this.recoveryTimer) {
			nodeClearTimeout(this.recoveryTimer);
			this.recoveryTimer = null;
		}
		if (this.rl) {
			this.rl.close();
			this.rl = null;
		}
		if (this.proc && !this.proc.killed) {
			this.proc.kill();
		}
		this.proc = null;
		this.initialized = false;
		this.sessionId = null;
		this.activeModelId = null;
		this.rejectAllPending(new Error('Antigravity ACP client closed'));
	}

	private rejectAllPending(err: Error): void {
		for (const [, p] of this.pending) {
			p.reject(err);
		}
		this.pending.clear();
	}

	private sendRequest(
		method: string,
		params: Record<string, unknown>,
		onId?: (id: number) => void,
	): Promise<unknown> {
		if (!this.proc?.stdin || this.proc.killed) {
			return Promise.reject(
				new Error('Antigravity ACP process is not running'),
			);
		}

		const id = this.nextId++;
		onId?.(id);
		const payload = JSON.stringify({
			jsonrpc: '2.0',
			id,
			method,
			params,
		});

		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.proc!.stdin!.write(`${payload}\n`, (err) => {
				if (err) {
					this.pending.delete(id);
					reject(err);
				}
			});
		});
	}

	private sendNotification(
		method: string,
		params: Record<string, unknown>,
	): void {
		if (!this.proc?.stdin || this.proc.killed) return;
		this.proc.stdin.write(
			`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`,
		);
	}

	private sendResponse(id: number | string, result: unknown): void {
		if (!this.proc?.stdin || this.proc.killed) return;
		this.proc.stdin.write(
			`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`,
		);
	}

	private sendError(id: number | string, code: number, message: string): void {
		if (!this.proc?.stdin || this.proc.killed) return;
		this.proc.stdin.write(
			`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`,
		);
	}

	private cancelActiveElicitations(): void {
		for (const cancel of this.activeElicitationCancels) {
			try {
				cancel();
			} catch {
				// Ignore listener errors during cancellation
			}
		}
		this.activeElicitationCancels.clear();
	}

	private handleLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;

		let msg: {
			id?: number | string;
			method?: string;
			params?: Record<string, unknown>;
			result?: unknown;
			error?: { code?: number; message?: string };
		};

		try {
			msg = JSON.parse(trimmed) as typeof msg;
		} catch {
			return;
		}

		// Response to a client->agent request
		if (
			typeof msg.id === 'number' &&
			!msg.method &&
			this.pending.has(msg.id)
		) {
			const entry = this.pending.get(msg.id)!;
			this.pending.delete(msg.id);
			if (msg.error) {
				entry.reject(
					new Error(
						msg.error.message ||
							`ACP error (code ${msg.error.code ?? 'unknown'})`,
					),
				);
			} else {
				entry.resolve(msg.result);
			}
			return;
		}

		// Agent->client permission request
		if (msg.method === 'session/request_permission' && msg.id !== undefined) {
			this.handlePermissionRequest(msg.id, msg.params ?? {});
			return;
		}

		// Agent->client interactive form elicitation (e.g. ask_question)
		if (msg.method === 'elicitation/create' && msg.id !== undefined) {
			void this.handleElicitationRequest(msg.id, msg.params ?? {});
			return;
		}

		// Agent->client streaming update notification
		if (msg.method === 'session/update' && msg.params) {
			this.handleSessionUpdate(msg.params);
		}
	}

	private async handleElicitationRequest(
		id: number | string,
		params: Record<string, unknown>,
	): Promise<void> {
		if (this.turnCancelled) {
			this.sendResponse(id, { action: 'cancel' });
			return;
		}

		const parsed = parseElicitationRequest(params);
		if (parsed.unsupportedMode) {
			this.sendError(
				id,
				-32602,
				`Unsupported elicitation mode: ${parsed.unsupportedMode}`,
			);
			return;
		}

		const request = parsed.request;
		const handler = this.activeCallbacks?.onElicitation;
		if (!request || !handler) {
			this.sendResponse(id, { action: 'decline' });
			return;
		}

		let cancelPending: (() => void) | null = null;
		const cancelPromise = new Promise<ElicitationResponse>((resolve) => {
			cancelPending = () => resolve({ action: 'cancel' });
		});
		const cancelFn = () => cancelPending?.();
		this.activeElicitationCancels.add(cancelFn);

		try {
			const response = await Promise.race([
				handler(request).catch(
					(): ElicitationResponse => ({ action: 'decline' }),
				),
				cancelPromise,
			]);

			const finalAction = this.turnCancelled ? 'cancel' : response.action;
			if (request.toolCallId) {
				this.elicitationOutcomes.set(request.toolCallId, {
					action: finalAction,
					answers: finalAction === 'accept' ? (response.summary ?? []) : [],
				});
			}

			if (finalAction === 'accept') {
				this.sendResponse(id, {
					action: 'accept',
					content: response.content ?? {},
				});
			} else {
				this.sendResponse(id, { action: finalAction });
			}
		} finally {
			this.activeElicitationCancels.delete(cancelFn);
		}
	}

	private handlePermissionRequest(
		id: number | string,
		params: Record<string, unknown>,
	): void {
		if (this.turnCancelled) {
			this.sendResponse(id, { outcome: { outcome: 'cancelled' } });
			return;
		}
		const toolCall = params.toolCall as
			| { title?: string; name?: string; rawInput?: Record<string, unknown> }
			| undefined;
		const options =
			(params.options as { optionId: string; kind?: string }[] | undefined) ??
			[];

		const rawName = toolCall?.name ?? toolCall?.title ?? '';
		const isVaultMcpTool = rawName.includes(MCP_SERVER_NAME);
		const isSafeBuiltin = SAFE_BUILTIN_TOOLS.has(rawName);

		if (isVaultMcpTool || isSafeBuiltin) {
			const allowOpt =
				options.find((o) => o.kind === 'allow_once') ??
				options.find((o) => o.kind === 'allow_always') ??
				options[0];
			this.sendResponse(id, {
				outcome: allowOpt
					? { outcome: 'selected', optionId: allowOpt.optionId }
					: { outcome: 'cancelled' },
			});
			return;
		}

		// Reject direct filesystem/shell mutations so edits go through Obsidian's staged ChangeSets
		const rejectOpt =
			options.find((o) => o.kind === 'reject_once') ??
			options.find((o) => o.kind === 'reject_always');
		this.sendResponse(id, {
			outcome: rejectOpt
				? { outcome: 'selected', optionId: rejectOpt.optionId }
				: { outcome: 'cancelled' },
		});
	}

	private handleSessionUpdate(params: Record<string, unknown>): void {
		const update = params.update as
			| {
					sessionUpdate?: string;
					content?: { type?: string; text?: string };
					toolCallId?: string;
					name?: string;
					args?: Record<string, unknown>;
					rawInput?: Record<string, unknown>;
					rawOutput?: unknown;
					status?: string;
					used?: number;
					size?: number;
					title?: unknown;
					entries?: unknown;
			  }
			| undefined;

		if (!update?.sessionUpdate) return;

		if (update.sessionUpdate === 'session_info_update') {
			if (typeof update.title === 'string' && update.title.trim()) {
				this.sessionTitle = update.title.trim();
				this.emitSessionInfo();
			}
			return;
		}

		if (this.replayBuffer) {
			applyReplayUpdate(this.replayBuffer, update);
			return;
		}

		if (
			update.sessionUpdate === 'usage_update' &&
			typeof update.used === 'number' &&
			typeof update.size === 'number'
		) {
			this.contextUsage = { used: update.used, size: update.size };
			return;
		}

		if (update.sessionUpdate === 'plan') {
			if (this.turnCancelled) return;
			const steps = parsePlanSteps(update.entries);
			if (steps.length > 0) {
				this.activeCallbacks?.onPlanUpdate?.(steps);
			}
			return;
		}

		if (update.sessionUpdate === 'agent_thought_chunk') {
			if (this.turnCancelled) return;
			const text = update.content?.text;
			if (text) {
				this.activeCallbacks?.onThoughtDelta?.(text);
			}
			return;
		}

		if (update.sessionUpdate === 'agent_message_chunk') {
			if (this.turnCancelled) return;
			const text = update.content?.text;
			if (text) {
				this.activeAnswerChunks.push(text);
				this.activeCallbacks?.onAnswerDelta?.(text);
			}
			return;
		}

		if (update.sessionUpdate === 'tool_call') {
			if (this.turnCancelled) return;
			const rawName = update.name ?? '';
			const displayName = rawName.startsWith(MCP_TOOL_PREFIX)
				? rawName.slice(MCP_TOOL_PREFIX.length)
				: rawName;
			if (update.toolCallId) {
				this.activeToolNames.set(update.toolCallId, displayName);
			}
			const toolArgs = update.args ?? update.rawInput ?? {};
			if (displayName === 'update_steps') {
				const steps = parsePlanSteps(toolArgs);
				if (steps.length > 0) {
					this.activeCallbacks?.onPlanUpdate?.(steps);
				}
				return;
			}
			if (displayName === 'update_focus') {
				const focus = parseFocusText(toolArgs);
				if (focus) {
					this.activeCallbacks?.onFocusUpdate?.(focus);
				}
				return;
			}
			// MCP tools already emit precise start/end events from McpToolServer;
			// emit for non-MCP built-in tools (like search_web) here.
			if (!rawName.startsWith(MCP_TOOL_PREFIX)) {
				this.activeCallbacks?.onToolStart?.(
					displayName,
					toolArgs,
					update.toolCallId,
				);
			}
			return;
		}

		if (
			update.sessionUpdate === 'tool_call_update' &&
			(update.status === 'completed' || update.status === 'failed')
		) {
			const toolCallId = update.toolCallId ?? '';
			const displayName =
				this.activeToolNames.get(toolCallId) ?? update.name ?? '';
			const rawName = update.name ?? '';
			if (PROGRESS_BUILTIN_TOOLS.has(displayName)) {
				return;
			}
			if (!rawName.startsWith(MCP_TOOL_PREFIX) && displayName) {
				const elicitationOutcome = toolCallId
					? this.elicitationOutcomes.get(toolCallId)
					: undefined;
				if (toolCallId && elicitationOutcome) {
					this.elicitationOutcomes.delete(toolCallId);
				}
				this.activeCallbacks?.onToolEnd?.(
					displayName,
					update.rawOutput ?? elicitationOutcome ?? { status: update.status },
					toolCallId || undefined,
				);
			}
		}
	}
}

/** Merges consecutive chunks of the same role into one replayed message. */
export function appendReplayChunk(
	buffer: ReplayedMessage[],
	role: ReplayedMessage['role'],
	text: string,
): void {
	const last = buffer[buffer.length - 1];
	if (last && last.role === role) {
		last.text += text;
	} else {
		buffer.push(role === 'agent' ? { role, text, events: [] } : { role, text });
	}
}

/** Validates untrusted `session/list` entries and keeps only this vault's sessions. */
export function parseSessionList(
	raw: unknown,
	cwd: string,
): AcpSessionSummary[] {
	if (!Array.isArray(raw)) return [];
	const out: AcpSessionSummary[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== 'object') continue;
		const e = entry as Record<string, unknown>;
		if (typeof e.sessionId !== 'string' || !e.sessionId) continue;
		if (typeof e.cwd === 'string' && e.cwd !== cwd) continue;
		out.push({
			sessionId: e.sessionId,
			title:
				typeof e.title === 'string' && e.title.trim()
					? e.title.trim()
					: undefined,
			updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : undefined,
		});
	}
	return out;
}

function dedupeSessions(sessions: AcpSessionSummary[]): AcpSessionSummary[] {
	const seen = new Set<string>();
	return sessions.filter((s) => {
		if (seen.has(s.sessionId)) return false;
		seen.add(s.sessionId);
		return true;
	});
}

function sortSessionsNewestFirst(
	sessions: AcpSessionSummary[],
): AcpSessionSummary[] {
	const time = (s: AcpSessionSummary) => {
		const t = s.updatedAt ? Date.parse(s.updatedAt) : NaN;
		return Number.isFinite(t) ? t : 0;
	};
	return [...sessions].sort((a, b) => time(b) - time(a));
}

/** Returns the agent message receiving replay events, starting one if needed. */
function currentAgentMessage(buffer: ReplayedMessage[]): ReplayedMessage {
	const last = buffer[buffer.length - 1];
	if (last && last.role === 'agent') return last;
	const msg: ReplayedMessage = { role: 'agent', text: '', events: [] };
	buffer.push(msg);
	return msg;
}

function displayToolName(rawName: string): string {
	return rawName.startsWith(MCP_TOOL_PREFIX)
		? rawName.slice(MCP_TOOL_PREFIX.length)
		: rawName;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
	return v && typeof v === 'object' && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: undefined;
}

/**
 * Turns a stored tool result into the shape live tool events carry: MCP text
 * content and JSON strings are parsed, and failures expose an `error` field.
 */
export function normalizeReplayedToolOutput(
	raw: unknown,
	status?: string,
): unknown {
	let out = raw;
	if (Array.isArray(out)) {
		const texts = out
			.map((c) => asRecord(c))
			.filter((c): c is Record<string, unknown> => !!c && c.type === 'text')
			.map((c) => (typeof c.text === 'string' ? c.text : ''));
		if (texts.length > 0 && texts.length === out.length) out = texts.join('\n');
	}
	const mcp = asRecord(out);
	if (mcp && Array.isArray(mcp.content)) {
		return normalizeReplayedToolOutput(mcp.content, status);
	}
	if (typeof out === 'string') {
		try {
			out = JSON.parse(out);
		} catch {
			// Plain text output (e.g. a built-in tool's stdout).
		}
	}
	if (status === 'failed') {
		const rec = asRecord(out);
		if (!rec || !('error' in rec)) {
			return {
				error:
					out === undefined
						? 'Tool call failed'
						: typeof out === 'string'
							? out
							: JSON.stringify(out),
			};
		}
	}
	// The CLI does not store MCP tool results: report "not stored", never a fake result.
	return out;
}

/** Applies one `session/load` replay update to the buffer (pure; unit-tested). */
export function applyReplayUpdate(
	buffer: ReplayedMessage[],
	update: {
		sessionUpdate?: string;
		content?: { type?: string; text?: string };
		toolCallId?: string;
		name?: string;
		title?: unknown;
		args?: Record<string, unknown>;
		rawInput?: Record<string, unknown>;
		rawOutput?: unknown;
		status?: string;
		entries?: unknown;
	},
): void {
	const kind = update.sessionUpdate;
	const text = update.content?.text;
	if (kind === 'user_message_chunk' && typeof text === 'string') {
		appendReplayChunk(buffer, 'user', text);
		return;
	}
	if (kind === 'agent_message_chunk' && typeof text === 'string') {
		appendReplayChunk(buffer, 'agent', text);
		return;
	}
	if (kind === 'plan') {
		const steps = parsePlanSteps(update.entries);
		if (steps.length > 0) {
			const events = (currentAgentMessage(buffer).events ??= []);
			events.push({
				type: 'tool',
				toolName: 'update_steps',
				toolArgs: { steps },
				status: 'completed',
			});
		}
		return;
	}
	if (kind === 'agent_thought_chunk' && typeof text === 'string') {
		const events = (currentAgentMessage(buffer).events ??= []);
		const last = events[events.length - 1];
		if (last && last.type === 'thought') last.text += text;
		else events.push({ type: 'thought', text });
		return;
	}
	if (kind === 'tool_call') {
		const events = (currentAgentMessage(buffer).events ??= []);
		const done = update.status === 'completed' || update.status === 'failed';
		events.push({
			type: 'tool',
			callId: update.toolCallId,
			toolName: displayToolName(update.name ?? ''),
			toolArgs: asRecord(update.args) ?? asRecord(update.rawInput) ?? {},
			status: update.status,
			output: done
				? normalizeReplayedToolOutput(update.rawOutput, update.status)
				: undefined,
		});
		return;
	}
	if (kind === 'tool_call_update' && update.toolCallId) {
		const last = buffer[buffer.length - 1];
		const tool = last?.events?.find(
			(e): e is Extract<ReplayedAgentEvent, { type: 'tool' }> =>
				e.type === 'tool' && e.callId === update.toolCallId,
		);
		if (!tool) return;
		if (update.status) tool.status = update.status;
		if (update.status === 'completed' || update.status === 'failed') {
			tool.output = normalizeReplayedToolOutput(
				update.rawOutput ?? tool.output,
				update.status,
			);
		}
	}
}
