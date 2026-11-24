import type { ToolDeclaration } from '../tools';

export interface ToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
	thoughtSignature?: string;
}

export interface ToolResult {
	id: string;
	name: string;
	output: unknown;
}

export interface MediaInput {
	type: 'video' | 'image' | 'audio';
	uri?: string;
	mimeType?: string;
	data?: string;
}

export interface Message {
	role: 'user' | 'assistant';
	text?: string;
	media?: MediaInput[];
	toolCalls?: ToolCall[];
	toolResults?: ToolResult[];
}

export interface AgentRequest {
	systemPrompt?: string;
	messages: Message[];
	tools?: ToolDeclaration[];
	model?: string;
}

export interface TokenUsage {
	promptTokens?: number;
	candidatesTokens?: number;
	totalTokens?: number;
	/** Input tokens served from the provider's prompt cache. */
	cachedReadTokens?: number;
	/** Input tokens written to the provider's prompt cache. */
	cachedWriteTokens?: number;
	/** Reasoning ("thinking") tokens. */
	thoughtTokens?: number;
}

export interface AgentResponse {
	text?: string;
	toolCalls?: ToolCall[];
	stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'error';
	usage?: TokenUsage;
}

export interface ModelProvider {
	complete(
		request: AgentRequest,
		onText?: (text: string, thought: boolean) => void,
	): Promise<AgentResponse>;
}
