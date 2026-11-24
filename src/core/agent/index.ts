import { ActiveContext, ContextReference } from '../types/context';
import { Message, MediaInput } from '../types/model';
import { ChangeSet } from '../types/changes';
import { Tool, ToolRegistry } from '../tools';
import { ChangeStagingManager } from '../transactions';
import { AntigravityProvider } from '../models/antigravity-provider';

export interface AgentOptions {
	provider: AntigravityProvider;
	tools?: ToolRegistry | Tool[];
	stagingManager?: ChangeStagingManager;
	systemPrompt?: string;
}

export type AgentStepEvent =
	| { type: 'thinking' }
	| { type: 'thought_delta'; text: string }
	| { type: 'answer_start' }
	| { type: 'answer_delta'; text: string }
	| { type: 'tool_start'; toolName: string; toolArgs: Record<string, unknown> }
	| { type: 'tool_end'; toolName: string; toolOutput: unknown }
	| {
			type: 'answer';
			text: string;
			contextUsed?: ContextReference[];
			changeSet?: ChangeSet;
	  }
	| { type: 'error'; message: string };

export interface AgentRunResult {
	answer: string;
	updatedHistory: Message[];
	contextUsed: ContextReference[];
	changeSet?: ChangeSet;
	usage?: {
		promptTokens: number;
		candidatesTokens: number;
		totalTokens: number;
	};
}

export const DEFAULT_AGENT_SYSTEM_PROMPT = `You are Anti-dian, an intelligent note-taking companion inside Obsidian.
Use the anti-dian-vault MCP tools (search_notes, read_note, create_note, edit_note, patch_note) for all Obsidian vault operations so changes are staged safely for user review and approval.
Never write directly to vault files via raw filesystem or shell tools.
When citing notes, use [[Note Name]] wikilink syntax. Keep responses helpful and concise.`;

export class Agent {
	private provider: AntigravityProvider;
	private registry: ToolRegistry;
	private stagingManager?: ChangeStagingManager;

	constructor(options: AgentOptions) {
		this.provider = options.provider;
		this.stagingManager = options.stagingManager;

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
	}

	getRegistry(): ToolRegistry {
		return this.registry;
	}

	getStagingManager(): ChangeStagingManager | undefined {
		return this.stagingManager;
	}

	async resetSession(): Promise<void> {
		await this.provider.resetSession();
	}

	async run(
		userMessage: string,
		context?: ActiveContext,
		history: Message[] = [],
		onStep?: (event: AgentStepEvent) => void,
		media?: MediaInput[],
		beforeTool?: () => Promise<void>,
	): Promise<AgentRunResult> {
		const rawContextUsed: ContextReference[] = [];
		const readMtimes: Map<string, number> = new Map();
		const activeTurnChangeSet = this.stagingManager?.startTurn();

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
				media,
			},
		];

		onStep?.({ type: 'thinking' });
		onStep?.({ type: 'answer_start' });

		const mcpServer = this.provider.getMcpToolServer();
		mcpServer?.setTurnContext(
			{
				context,
				recordContext: (ref: ContextReference) => {
					rawContextUsed.push(ref);
				},
				recordReadMtime: (path: string, mtime: number) => {
					readMtimes.set(path, mtime);
				},
				getReadMtime: (path: string) => readMtimes.get(path),
			},
			{
				onToolStart: ({ toolName, toolArgs }) => {
					void beforeTool?.();
					onStep?.({ type: 'tool_start', toolName, toolArgs });
				},
				onToolEnd: ({ toolName, toolOutput }) => {
					onStep?.({ type: 'tool_end', toolName, toolOutput });
				},
			},
		);

		try {
			const result = await this.provider.runTurn(fullUserPrompt, media, {
				onThoughtDelta: (text) =>
					onStep?.({ type: 'thought_delta', text }),
				onAnswerDelta: (text) =>
					onStep?.({ type: 'answer_delta', text }),
				onToolStart: (toolName, toolArgs) => {
					void beforeTool?.();
					onStep?.({ type: 'tool_start', toolName, toolArgs });
				},
				onToolEnd: (toolName, toolOutput) => {
					onStep?.({ type: 'tool_end', toolName, toolOutput });
				},
			});

			const contextUsed = this.deduplicateContext(rawContextUsed);
			const finalChangeSet =
				activeTurnChangeSet && activeTurnChangeSet.operations.length > 0
					? activeTurnChangeSet
					: undefined;

			onStep?.({
				type: 'answer',
				text: result.answer,
				contextUsed,
				changeSet: finalChangeSet,
			});

			currentMessages.push({
				role: 'assistant',
				text: result.answer,
			});

			const usage = result.usage
				? {
						promptTokens: result.usage.promptTokens ?? 0,
						candidatesTokens: result.usage.candidatesTokens ?? 0,
						totalTokens:
							result.usage.totalTokens ??
							(result.usage.promptTokens ?? 0) +
								(result.usage.candidatesTokens ?? 0),
					}
				: undefined;

			return {
				answer: result.answer,
				updatedHistory: currentMessages,
				contextUsed,
				changeSet: finalChangeSet,
				usage,
			};
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			onStep?.({ type: 'error', message: errMsg });
			return {
				answer: `Error communicating with Antigravity CLI: ${errMsg}`,
				updatedHistory: currentMessages,
				contextUsed: this.deduplicateContext(rawContextUsed),
			};
		} finally {
			mcpServer?.clearTurnContext();
		}
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
