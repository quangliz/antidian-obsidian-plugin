import { ToolDeclaration } from '../tools';

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
	uri: string;
	mimeType?: string;
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
}

export interface AgentResponse {
	text?: string;
	toolCalls?: ToolCall[];
	stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'error';
	usage?: TokenUsage;
}

export interface ModelProvider {
	complete(request: AgentRequest): Promise<AgentResponse>;
}
