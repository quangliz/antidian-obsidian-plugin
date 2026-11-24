import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { MediaInput, TokenUsage } from '../types/model';
import { McpToolServer } from './mcp-tool-server';

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

export interface AcpStreamCallbacks {
	onThoughtDelta?: (text: string) => void;
	onAnswerDelta?: (text: string) => void;
	onToolStart?: (
		toolName: string,
		toolArgs: Record<string, unknown>,
		callId?: string,
	) => void;
	onToolEnd?: (toolName: string, toolOutput: unknown, callId?: string) => void;
}

export interface AcpPromptResult {
	answer: string;
	stopReason?: string;
	usage?: TokenUsage;
}

export interface AntigravityAcpOptions {
	cliPath?: string;
	cwd?: string;
	model?: string;
	systemPrompt?: string;
	mcpToolServer?: McpToolServer;
}

const MCP_SERVER_NAME = 'anti-dian-vault';
const MCP_TOOL_PREFIX = `mcp_${MCP_SERVER_NAME}_`;

const SAFE_BUILTIN_TOOLS = new Set([
	'search_web',
	'web_search',
	'google_search',
]);

export function formatTokens(tokens?: number): string {
	if (!tokens) return '';
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
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

	const candidates = [
		path.join(os.homedir(), '.local', 'bin', 'agy'),
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

	return 'agy';
}

export function isAgyBinaryAvailable(customPath?: string): boolean {
	const bin = resolveAgyBinary(customPath);
	if (bin.includes(path.sep)) {
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
	};
}

export class AntigravityAcpClient {
	private cliPath?: string;
	private cwd: string;
	private model?: string;
	private systemPrompt?: string;
	private mcpToolServer?: McpToolServer;

	private proc: ChildProcess | null = null;
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
	private contextUsage: ContextWindowUsage | null = null;
	private activeCallbacks: AcpStreamCallbacks | null = null;
	private activeAnswerChunks: string[] = [];
	private activeToolNames = new Map<string, string>();
	private startPromise: Promise<void> | null = null;

	constructor(options: AntigravityAcpOptions = {}) {
		this.cliPath = options.cliPath;
		this.cwd = options.cwd ?? process.cwd();
		this.model = options.model;
		this.systemPrompt = options.systemPrompt;
		this.mcpToolServer = options.mcpToolServer;
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

	async fetchUserQuota(force = false): Promise<UserQuotaResponse | null> {
		const now = Date.now();
		if (
			!force &&
			this.cachedQuota &&
			now - this.cachedQuota.fetchedAt < 30_000
		) {
			return {
				...this.cachedQuota.data,
				accountTier: this.cachedTier ?? this.cachedQuota.data.accountTier,
			};
		}

		const bin = resolveAgyBinary(this.cliPath);
		try {
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

			const data: UserQuotaResponse = {
				groups,
				accountTier: this.cachedTier,
			};
			this.cachedQuota = { data, fetchedAt: now };
			return data;
		} catch {
			return this.cachedTier
				? { groups: [], accountTier: this.cachedTier }
				: null;
		}
	}

	async checkStatus(): Promise<{
		cliFound: boolean;
		authenticated: boolean;
		tier?: AccountTierInfo | null;
		error?: string;
	}> {
		const cliFound = isAgyBinaryAvailable(this.cliPath);
		if (!cliFound) {
			return {
				cliFound: false,
				authenticated: false,
				error: 'Antigravity CLI (agy) not found in PATH or ~/.local/bin/agy.',
			};
		}

		try {
			await this.ensureSession();
			return {
				cliFound: true,
				authenticated: true,
				tier: this.cachedTier,
			};
		} catch (err) {
			return {
				cliFound: true,
				authenticated: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async login(): Promise<void> {
		const bin = resolveAgyBinary(this.cliPath);
		await new Promise<void>((resolve, reject) => {
			const child = spawn(bin, ['acp', '--login'], {
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

	async resetSession(): Promise<void> {
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

	async prompt(
		text: string,
		media?: MediaInput[],
		callbacks?: AcpStreamCallbacks,
	): Promise<AcpPromptResult> {
		await this.ensureSession();

		if (this.model && this.activeModelId !== this.model) {
			await this.applyModel(this.model);
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

		this.activeCallbacks = callbacks ?? null;
		this.activeAnswerChunks = [];
		this.activeToolNames.clear();

		try {
			const result = (await this.sendRequest('session/prompt', {
				sessionId: this.sessionId,
				prompt: promptBlocks,
			})) as AcpPromptResponse;

			const usage: TokenUsage | undefined = result?.usage
				? {
						promptTokens: result.usage.inputTokens,
						candidatesTokens: result.usage.outputTokens,
						totalTokens: result.usage.totalTokens,
					}
				: undefined;

			return {
				answer:
					this.activeAnswerChunks.join('').trim() ||
					'(No response text generated)',
				stopReason: result?.stopReason,
				usage,
			};
		} finally {
			this.activeCallbacks = null;
			this.activeAnswerChunks = [];
			this.activeToolNames.clear();
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

	private async startAndCreateSession(): Promise<void> {
		if (!this.proc || this.proc.killed) {
			this.spawnProcess();
		}

		if (!this.initialized) {
			await this.sendRequest('initialize', {
				protocolVersion: 1,
				clientCapabilities: {},
				clientInfo: {
					name: 'anti-dian',
					version: '1.0.0',
				},
			});
			this.initialized = true;
		}

		if (!this.sessionId) {
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

			const sess = (await this.sendRequest(
				'session/new',
				params,
			)) as AcpSessionNewResult;

			this.sessionId = sess.sessionId;
			this.activeModelId = sess.models?.currentModelId ?? null;

			const rawModels = sess.models?.availableModels ?? [];
			const models: AvailableModel[] = rawModels.map((m) => ({
				id: m.modelId,
				displayName: m.name || m.modelId,
			}));

			this.cachedModels = {
				models,
				groups: groupModels(models),
				defaultModelId: sess.models?.currentModelId,
			};

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

	private buildEnv(): NodeJS.ProcessEnv {
		const env = { ...process.env };
		const localBin = path.join(os.homedir(), '.local', 'bin');
		const currentPath = env.PATH ?? '';
		if (!currentPath.split(path.delimiter).includes(localBin)) {
			env.PATH = `${localBin}${path.delimiter}${currentPath}`;
		}
		return env;
	}

	private spawnProcess(): void {
		const bin = resolveAgyBinary(this.cliPath);
		this.proc = spawn(bin, ['acp'], {
			cwd: this.cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: this.buildEnv(),
		});

		this.proc.stderr?.on('data', () => {
			// Ignore verbose CLI stderr logs
		});

		this.proc.on('error', (err) => {
			this.rejectAllPending(
				new Error(`Failed to start Antigravity CLI (${bin}): ${err.message}`),
			);
			this.destroyProcess();
		});

		this.proc.on('exit', (code) => {
			this.rejectAllPending(
				new Error(`Antigravity ACP process exited (code ${code ?? 'unknown'})`),
			);
			this.proc = null;
			this.rl = null;
			this.initialized = false;
			this.sessionId = null;
			this.activeModelId = null;
		});

		if (this.proc.stdout) {
			this.rl = readline.createInterface({ input: this.proc.stdout });
			this.rl.on('line', (line) => {
				this.handleLine(line);
			});
		}
	}

	private destroyProcess(): void {
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
	): Promise<unknown> {
		if (!this.proc?.stdin || this.proc.killed) {
			return Promise.reject(
				new Error('Antigravity ACP process is not running'),
			);
		}

		const id = this.nextId++;
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

	private sendResponse(id: number | string, result: unknown): void {
		if (!this.proc?.stdin || this.proc.killed) return;
		this.proc.stdin.write(
			`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`,
		);
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

		// Agent->client streaming update notification
		if (msg.method === 'session/update' && msg.params) {
			this.handleSessionUpdate(msg.params);
		}
	}

	private handlePermissionRequest(
		id: number | string,
		params: Record<string, unknown>,
	): void {
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
			  }
			| undefined;

		if (!update?.sessionUpdate) return;

		if (
			update.sessionUpdate === 'usage_update' &&
			typeof update.used === 'number' &&
			typeof update.size === 'number'
		) {
			this.contextUsage = { used: update.used, size: update.size };
			return;
		}

		if (update.sessionUpdate === 'agent_thought_chunk') {
			const text = update.content?.text;
			if (text) {
				this.activeCallbacks?.onThoughtDelta?.(text);
			}
			return;
		}

		if (update.sessionUpdate === 'agent_message_chunk') {
			const text = update.content?.text;
			if (text) {
				this.activeAnswerChunks.push(text);
				this.activeCallbacks?.onAnswerDelta?.(text);
			}
			return;
		}

		if (update.sessionUpdate === 'tool_call') {
			const rawName = update.name ?? '';
			const displayName = rawName.startsWith(MCP_TOOL_PREFIX)
				? rawName.slice(MCP_TOOL_PREFIX.length)
				: rawName;
			if (update.toolCallId) {
				this.activeToolNames.set(update.toolCallId, displayName);
			}
			// MCP tools already emit precise start/end events from McpToolServer;
			// emit for non-MCP built-in tools (like search_web) here.
			if (!rawName.startsWith(MCP_TOOL_PREFIX)) {
				this.activeCallbacks?.onToolStart?.(
					displayName,
					update.args ?? update.rawInput ?? {},
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
			if (!rawName.startsWith(MCP_TOOL_PREFIX) && displayName) {
				this.activeCallbacks?.onToolEnd?.(
					displayName,
					update.rawOutput ?? { status: update.status },
					toolCallId || undefined,
				);
			}
		}
	}
}
