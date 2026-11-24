import type { MediaInput } from '../types/model';
import {
	type AccountTierInfo,
	type AcpPromptResult,
	type AcpSessionSummary,
	type AcpStreamCallbacks,
	AntigravityAcpClient,
	type AntigravityAcpOptions,
	type AvailableModelsResponse,
	type ContextWindowUsage,
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

	setModel(model: string): void {
		this.client.setModel(model);
	}

	getModel(): string {
		return this.client.getModel();
	}

	getAccountTier(): AccountTierInfo | null {
		return this.client.getAccountTier();
	}

	getContextUsage(): ContextWindowUsage | null {
		return this.client.getContextUsage();
	}

	async fetchUserQuota(force = false): Promise<UserQuotaResponse | null> {
		return this.client.fetchUserQuota(force);
	}

	async checkStatus(): Promise<{
		cliFound: boolean;
		authenticated: boolean;
		tier?: AccountTierInfo | null;
		error?: string;
	}> {
		return this.client.checkStatus();
	}

	async login(): Promise<void> {
		return this.client.login();
	}

	async fetchAvailableModels(): Promise<AvailableModelsResponse> {
		return this.client.fetchAvailableModels();
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
	): Promise<AcpPromptResult> {
		return this.client.prompt(prompt, media, callbacks, signal);
	}

	async destroy(): Promise<void> {
		return this.client.destroy();
	}
}
