import { ActiveContext, ContextReference } from '../types/context';
import { ModelProvider, Message, ToolResult } from '../types/model';
import { Tool, ToolRegistry } from '../tools';

export interface AgentOptions {
	provider: ModelProvider;
	tools?: ToolRegistry | Tool[];
	maxTurns?: number;
	systemPrompt?: string;
}

export type AgentStepEvent =
	| { type: 'thinking' }
	| { type: 'tool_start'; toolName: string; toolArgs: Record<string, unknown> }
	| { type: 'tool_end'; toolName: string; toolOutput: unknown }
	| { type: 'answer'; text: string; contextUsed?: ContextReference[] }
	| { type: 'error'; message: string };

export interface AgentRunResult {
	answer: string;
	updatedHistory: Message[];
	contextUsed: ContextReference[];
}

export class Agent {
	private provider: ModelProvider;
	private registry: ToolRegistry;
	private maxTurns: number;
	private systemPrompt: string;

	constructor(options: AgentOptions) {
		this.provider = options.provider;
		if (options.tools instanceof ToolRegistry) {
			this.registry = options.tools;
		} else {
			this.registry = new ToolRegistry();
			if (Array.isArray(options.tools)) {
				for (const tool of options.tools) {
					this.registry.register(tool);
				}
			}
		}

		this.maxTurns = options.maxTurns ?? 6;
		this.systemPrompt =
			options.systemPrompt ??
			`You are Anti-dian, an intelligent note-taking companion inside Obsidian.
Use your tools to search and read notes in the vault to provide accurate, grounded answers.
When citing notes, use [[Note Name]] wikilink syntax. Keep responses helpful and concise.`;
	}

	getRegistry(): ToolRegistry {
		return this.registry;
	}

	async run(
		userMessage: string,
		context?: ActiveContext,
		history: Message[] = [],
		onStep?: (event: AgentStepEvent) => void,
	): Promise<AgentRunResult> {
		const rawContextUsed: ContextReference[] = [];

		let contextPrefix = '';
		if (context?.activeFile) {
			const noteName = context.activeFile
				.replace(/\.md$/, '')
				.split('/')
				.pop();
			contextPrefix += `[Current Active Note: [[${noteName}]] (path: ${context.activeFile})]`;
			if (context.selection) {
				contextPrefix += `\n[Selected Text in Editor:\n${context.selection}\n]`;
			}
			contextPrefix += '\n\n';

			rawContextUsed.push({
				path: context.activeFile,
				reason: 'Active note',
			});
		}

		const fullUserPrompt = contextPrefix
			? `${contextPrefix}${userMessage}`
			: userMessage;

		const currentMessages: Message[] = [
			...history,
			{
				role: 'user',
				text: fullUserPrompt,
			},
		];

		const toolDeclarations = this.registry.getDeclarations();

		let turn = 0;
		while (turn < this.maxTurns) {
			turn++;
			onStep?.({ type: 'thinking' });

			let response;
			try {
				response = await this.provider.complete({
					systemPrompt: this.systemPrompt,
					messages: currentMessages,
					tools:
						toolDeclarations.length > 0
							? toolDeclarations
							: undefined,
				});
			} catch (err) {
				const errMsg =
					err instanceof Error ? err.message : String(err);
				onStep?.({ type: 'error', message: errMsg });
				return {
					answer: `Error communicating with model: ${errMsg}`,
					updatedHistory: currentMessages,
					contextUsed: this.deduplicateContext(rawContextUsed),
				};
			}

			if (response.toolCalls && response.toolCalls.length > 0) {
				currentMessages.push({
					role: 'assistant',
					text: response.text,
					toolCalls: response.toolCalls,
				});

				const toolResults: ToolResult[] = [];
				for (const call of response.toolCalls) {
					onStep?.({
						type: 'tool_start',
						toolName: call.name,
						toolArgs: call.args,
					});

					const tool = this.registry.get(call.name);
					let output: unknown;
					if (tool) {
						try {
							output = await tool.execute(call.args, {
								context,
								recordContext: (ref: ContextReference) => {
									rawContextUsed.push(ref);
								},
							});
						} catch (err) {
							output = {
								error:
									err instanceof Error
										? err.message
										: String(err),
							};
						}
					} else {
						output = {
							error: `Tool ${call.name} not found in registry`,
						};
					}

					onStep?.({
						type: 'tool_end',
						toolName: call.name,
						toolOutput: output,
					});

					toolResults.push({
						id: call.id,
						name: call.name,
						output,
					});
				}

				currentMessages.push({
					role: 'user',
					toolResults,
				});
			} else {
				const answerText =
					response.text || '(No response text generated)';
				const contextUsed = this.deduplicateContext(rawContextUsed);
				onStep?.({ type: 'answer', text: answerText, contextUsed });
				currentMessages.push({
					role: 'assistant',
					text: answerText,
				});
				return { answer: answerText, updatedHistory: currentMessages, contextUsed };
			}
		}

		const fallback = 'Agent reached maximum tool turns limit.';
		const contextUsed = this.deduplicateContext(rawContextUsed);
		onStep?.({ type: 'answer', text: fallback, contextUsed });
		return { answer: fallback, updatedHistory: currentMessages, contextUsed };
	}

	private deduplicateContext(
		refs: ContextReference[],
	): ContextReference[] {
		const seen = new Set<string>();
		const result: ContextReference[] = [];

		for (const ref of refs) {
			const key = `${ref.path}#${ref.heading ?? ''}`;
			if (!seen.has(key)) {
				seen.add(key);
				result.push(ref);
			}
		}

		return result;
	}
}
