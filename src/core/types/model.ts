import { ToolDefinition } from '../tools';

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

export interface Message {
	role: 'user' | 'assistant';
	text?: string;
	toolCalls?: ToolCall[];
	toolResults?: ToolResult[];
}

export interface AgentRequest {
	systemPrompt?: string;
	messages: Message[];
	tools?: ToolDefinition[];
	model?: string;
}

export interface AgentResponse {
	text?: string;
	toolCalls?: ToolCall[];
	stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'error';
}

export interface ModelProvider {
	complete(request: AgentRequest): Promise<AgentResponse>;
}
