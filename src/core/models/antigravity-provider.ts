import { MediaInput } from '../types/model';
import {
	AccountTierInfo,
	AcpPromptResult,
	AcpStreamCallbacks,
	AntigravityAcpClient,
	AntigravityAcpOptions,
	AvailableModelsResponse,
} from './antigravity-acp';
import { McpToolServer } from './mcp-tool-server';

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

	async runTurn(
		prompt: string,
		media?: MediaInput[],
		callbacks?: AcpStreamCallbacks,
	): Promise<AcpPromptResult> {
		return this.client.prompt(prompt, media, callbacks);
	}

	async destroy(): Promise<void> {
		return this.client.destroy();
	}
}
