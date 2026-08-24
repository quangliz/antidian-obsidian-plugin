import {
	AgentRequest,
	AgentResponse,
	ModelProvider,
	ToolCall,
} from '../types/model';
import {
	getAccessToken,
	discoverProject,
	USER_AGENT,
	CLOUD_CODE_ENDPOINTS,
} from './antigravity-oauth';
import { httpRequest } from './http';

export interface GeminiProviderOptions {
	model?: string;
}

export class GeminiProvider implements ModelProvider {
	private model: string;
	private projectId?: string;

	constructor(options: GeminiProviderOptions = {}) {
		this.model = options.model ?? 'gemini-3.7-flash-high';
	}

	setModel(model: string): void {
		this.model = model;
	}

	getModel(): string {
		return this.model;
	}

	async complete(request: AgentRequest): Promise<AgentResponse> {
		const accessToken = await getAccessToken();
		if (!this.projectId) {
			this.projectId = await discoverProject(accessToken);
		}

		const targetModel = request.model ?? this.model;
		const contents = this.formatGeminiContents(request.messages);

		const body: Record<string, unknown> = {
			model: targetModel,
			project: this.projectId,
			request: {
				systemInstruction: request.systemPrompt
					? { parts: [{ text: request.systemPrompt }] }
					: undefined,
				contents,
			},
		};

		if (request.tools && request.tools.length > 0) {
			(body.request as Record<string, unknown>).tools = [
				{
					functionDeclarations: request.tools.map((t) => ({
						name: t.name,
						description: t.description,
						parameters: t.parameters,
					})),
				},
			];
		}

		const headers = {
			Authorization: `Bearer ${accessToken}`,
			'Content-Type': 'application/json',
			'User-Agent': USER_AGENT,
			Accept: 'text/event-stream',
		};

		let lastError: string | null = null;
		for (const endpoint of CLOUD_CODE_ENDPOINTS) {
			try {
				const res = await httpRequest(
					`${endpoint}/v1internal:streamGenerateContent?alt=sse`,
					{
						method: 'POST',
						headers,
						body: JSON.stringify(body),
					},
				);

				if (res.statusCode < 200 || res.statusCode >= 300) {
					lastError = `${res.statusCode}: ${res.body}`;
					continue;
				}

				return this.parseSSEResponse(res.body);
			} catch (err) {
				lastError = err instanceof Error ? err.message : String(err);
				continue;
			}
		}

		throw new Error(
			`All Antigravity OAuth endpoints failed. Last error: ${lastError ?? 'unknown'}`,
		);
	}

	private formatGeminiContents(
		messages: AgentRequest['messages'],
	): Record<string, unknown>[] {
		const contents: Record<string, unknown>[] = [];

		for (const msg of messages) {
			if (msg.role === 'user') {
				const parts: Record<string, unknown>[] = [];
				if (msg.text) {
					parts.push({ text: msg.text });
				}
				const mediaUris = new Set<string>();
				if (msg.media) {
					for (const m of msg.media) {
						mediaUris.add(m.uri);
						parts.push({
							fileData: {
								fileUri: m.uri,
								mimeType: m.mimeType ?? 'video/mp4',
							},
						});
					}
				}
				// ponytail: auto-detect YouTube URLs in prompt text so direct link pasting works without custom attachment UI
				if (msg.text) {
					const ytMatches = msg.text.match(
						/https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)[a-zA-Z0-9_-]+/g,
					);
					if (ytMatches) {
						for (const uri of ytMatches) {
							if (!mediaUris.has(uri)) {
								mediaUris.add(uri);
								parts.push({
									fileData: {
										fileUri: uri,
										mimeType: 'video/mp4',
									},
								});
							}
						}
					}
				}
				if (msg.toolResults) {
					for (const res of msg.toolResults) {
						parts.push({
							functionResponse: {
								name: res.name,
								id: res.id,
								response: { output: res.output },
							},
						});
					}
				}
				if (parts.length > 0) {
					contents.push({ role: 'user', parts });
				}
			} else if (msg.role === 'assistant') {
				const parts: Record<string, unknown>[] = [];
				if (msg.text) {
					parts.push({ text: msg.text });
				}
				if (msg.toolCalls) {
					for (const call of msg.toolCalls) {
						const part: Record<string, unknown> = {
							functionCall: {
								name: call.name,
								args: call.args,
								id: call.id,
							},
						};
						if (call.thoughtSignature) {
							part.thoughtSignature = call.thoughtSignature;
						}
						parts.push(part);
					}
				}
				if (parts.length > 0) {
					contents.push({ role: 'model', parts });
				}
			}
		}

		return contents;
	}

	private parseSSEResponse(sseText: string): AgentResponse {
		let text = '';
		const toolCalls: ToolCall[] = [];
		let stopReason: AgentResponse['stopReason'] = 'end_turn';
		let usage: AgentResponse['usage'];

		for (const line of sseText.split('\n')) {
			if (!line.startsWith('data:')) continue;
			const raw = line.slice(5).trim();
			if (!raw || raw === '[DONE]') continue;

			try {
				const event = JSON.parse(raw) as {
					response?: {
						candidates?: {
							content?: {
								parts?: {
									text?: string;
									functionCall?: {
										name: string;
										args: Record<string, unknown>;
										id?: string;
									};
									thoughtSignature?: string;
								}[];
							};
							finishReason?: string;
						}[];
						usageMetadata?: {
							promptTokenCount?: number;
							candidatesTokenCount?: number;
							totalTokenCount?: number;
						};
					};
					usageMetadata?: {
						promptTokenCount?: number;
						candidatesTokenCount?: number;
						totalTokenCount?: number;
					};
				};

				const u = event.response?.usageMetadata ?? event.usageMetadata;
				if (u) {
					usage = {
						promptTokens: u.promptTokenCount ?? usage?.promptTokens,
						candidatesTokens:
							u.candidatesTokenCount ?? usage?.candidatesTokens,
						totalTokens: u.totalTokenCount ?? usage?.totalTokens,
					};
				}

				const candidates = event.response?.candidates ?? [];
				for (const cand of candidates) {
					const parts = cand.content?.parts ?? [];
					for (const part of parts) {
						if (part.text) {
							text += part.text;
						}
						if (part.functionCall) {
							toolCalls.push({
								id:
									part.functionCall.id ??
									`call_${toolCalls.length + 1}`,
								name: part.functionCall.name,
								args: part.functionCall.args ?? {},
								thoughtSignature: part.thoughtSignature,
							});
							stopReason = 'tool_use';
						}
					}
					if (cand.finishReason === 'MAX_TOKENS') {
						stopReason = 'max_tokens';
					}
				}
			} catch {
				continue;
			}
		}

		return {
			text: text.trim() || undefined,
			toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
			stopReason,
			usage,
		};
	}
}
