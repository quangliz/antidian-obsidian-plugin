import type { MediaInput } from '../types/model';
import type {
	BinaryDownloadProgress,
	EnsureAgyBinaryResult,
} from './agy-binary-manager';
import {
	type AccountTierInfo,
	type AcpPromptResult,
	type AcpSessionSummary,
	type AcpStreamCallbacks,
	AntigravityAcpClient,
	type AntigravityAcpOptions,
	type AvailableCommand,
	type BackendConnection,
	type CachedQuotaSnapshot,
	type ContextWindowUsage,
	type ModelConfig,
	type ReplayedMessage,
	type UserQuotaResponse,
} from './antigravity-acp';
import type { McpToolServer } from './mcp-tool-server';

export type AntigravityProviderOptions = AntigravityAcpOptions;

export class AntigravityProvider {
	private client: AntigravityAcpClient;
	private mcpToolServer?: McpToolServer;

	constructor(options: AntigravityProviderOptions = {}) {
		this.mcpToolServer = options.mcpToolServer;
		this.client = new AntigravityAcpClient(options);
	}

	getMcpToolServer(): McpToolServer | undefined {
		return this.mcpToolServer;
	}

	setCliPath(cliPath?: string): void {
		this.client.setCliPath(cliPath);
	}

	setCaCertificates(caCertificates?: string): void {
		this.client.setCaCertificates(caCertificates);
	}

	setModel(model: string): void {
		this.client.setModel(model);
	}

	setThoughtLevel(level: string): void {
		this.client.setThoughtLevel(level);
	}

	getAccountTier(): AccountTierInfo | null {
		return this.client.getAccountTier();
	}

	getContextUsage(): ContextWindowUsage | null {
		return this.client.getContextUsage();
	}

	getAvailableCommands(): AvailableCommand[] {
		return this.client.getAvailableCommands();
	}

	getModelConfig(): ModelConfig | null {
		return this.client.getModelConfig();
	}

	getCachedUserQuota(): CachedQuotaSnapshot | null {
		return this.client.getCachedUserQuota();
	}

	warmup(): void {
		this.client.warmup();
	}

	prefetchQuota(force = false): void {
		this.client.prefetchQuota(force);
	}

	async fetchUserQuota(force = false): Promise<UserQuotaResponse | null> {
		return this.client.fetchUserQuota(force);
	}

	async ensureBinary(
		onProgress?: (progress: BinaryDownloadProgress) => void,
	): Promise<EnsureAgyBinaryResult> {
		return this.client.ensureBinary(onProgress);
	}

	async checkStatus(
		onProgress?: (progress: BinaryDownloadProgress) => void,
	): Promise<{
		cliFound: boolean;
		binaryPath?: string;
		authenticated: boolean;
		tier?: AccountTierInfo | null;
		error?: string;
	}> {
		return this.client.checkStatus(onProgress);
	}

	async login(
		onProgress?: (progress: BinaryDownloadProgress) => void,
		switchAccount = false,
	): Promise<void> {
		return this.client.login(onProgress, switchAccount);
	}

	cancelLogin(): void {
		this.client.cancelLogin();
	}

	getConnection(): BackendConnection {
		return this.client.getConnection();
	}

	onConnectionChange(listener: () => void): () => void {
		return this.client.onConnectionChange(listener);
	}

	async fetchModelConfig(): Promise<ModelConfig | null> {
		return this.client.fetchModelConfig();
	}

	async resetSession(): Promise<void> {
		return this.client.resetSession();
	}

	async listSessions(): Promise<AcpSessionSummary[]> {
		return this.client.listSessions();
	}

	async loadSession(sessionId: string): Promise<ReplayedMessage[]> {
		return this.client.loadSession(sessionId);
	}

	getSessionId(): string | null {
		return this.client.getSessionId();
	}

	getSessionTitle(): string | null {
		return this.client.getSessionTitle();
	}

	onSessionInfoChange(listener: () => void): () => void {
		return this.client.onSessionInfoChange(listener);
	}

	cancel(): void {
		this.client.cancel();
	}

	async runTurn(
		prompt: string,
		media?: MediaInput[],
		callbacks?: AcpStreamCallbacks,
		signal?: AbortSignal,
		context?: string,
	): Promise<AcpPromptResult> {
		return this.client.prompt(prompt, media, callbacks, signal, context);
	}

	async destroy(): Promise<void> {
		return this.client.destroy();
	}
}
