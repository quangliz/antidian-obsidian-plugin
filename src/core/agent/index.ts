import { ActiveContext, ContextReference } from '../types/context';
import { Message, MediaInput } from '../types/model';
import { ChangeSet } from '../types/changes';
import { HarnessPermissionMode, Tool, ToolRegistry } from '../tools';
import { ChangeStagingManager } from '../transactions';
import { ContextCompiler } from '../context/compiler';
import { AntigravityProvider } from '../models/antigravity-provider';

export interface AgentOptions {
	provider: AntigravityProvider;
	tools?: ToolRegistry | Tool[];
	stagingManager?: ChangeStagingManager;
	contextCompiler?: ContextCompiler;
	systemPrompt?: string;
}

export type AgentStepEvent =
	| { type: 'thinking' }
	| { type: 'thought_delta'; text: string }
	| { type: 'answer_start' }
	| { type: 'answer_delta'; text: string }
	| {
			type: 'tool_start';
			toolName: string;
			toolArgs: Record<string, unknown>;
			/** Pairs this start with its tool_end when the source provides one. */
			callId?: string;
	  }
	| { type: 'tool_end'; toolName: string; toolOutput: unknown; callId?: string }
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

export const DEFAULT_AGENT_SYSTEM_PROMPT = `You are Anti-dian, an intelligent note-taking and knowledge harness running inside Obsidian.

Tool rules (strict):
- ALWAYS use the \`anti-dian-vault\` MCP tools for every vault operation.
- NEVER invoke built-in filesystem, editor, or shell tools (such as read_file, edit_file, write_file, run_command, grep, find) to access or modify vault notes — they are blocked by Obsidian's safety boundary.
- Built-in web search (\`search_web\`) may be used when external information is needed.

Recommended vault workflow:
1. Discover & orient cheaply: use \`list_notes\` or \`search_notes\`, then \`get_note_outline\` (headings, frontmatter, tags, links, backlinks) before reading long notes in full with \`read_note\`.
2. Prefer structural edits over whole-file rewrites:
   - \`replace_block\` for localized exact-text edits
   - \`patch_note\` for replacing a specific heading section
   - \`append_note\` for adding content to the end of a note or under a heading
   - \`update_frontmatter\` for setting or removing YAML properties
   - \`create_note\` for new notes, and \`edit_note\` only when a full-file rewrite is truly needed.
3. All write tools stage changes for user diff/approval; \`read_note\` and \`get_note_outline\` automatically reflect edits staged earlier in the same turn.
4. If available vault skills are listed in context and match the request, call \`load_skill\` before proceeding.
5. In Plan Mode (read-only), do not call write tools; present your analysis and proposed edits in markdown.

Formatting:
- Cite vault notes with \`[[Note Name]]\` wikilink syntax.
- Keep responses helpful, accurate, and concise.`;

export class Agent {
	private provider: AntigravityProvider;
	private registry: ToolRegistry;
	private stagingManager?: ChangeStagingManager;
	private contextCompiler: ContextCompiler;

	constructor(options: AgentOptions) {
		this.provider = options.provider;
		this.stagingManager = options.stagingManager;
		this.contextCompiler = options.contextCompiler ?? new ContextCompiler();

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
		this.contextCompiler.reset();
		await this.provider.resetSession();
	}

	async run(
		userMessage: string,
		context?: ActiveContext,
		history: Message[] = [],
		onStep?: (event: AgentStepEvent) => void,
		media?: MediaInput[],
		beforeTool?: () => Promise<void>,
		permissionMode: HarnessPermissionMode = 'ask',
	): Promise<AgentRunResult> {
		const rawContextUsed: ContextReference[] = [];
		const readMtimes: Map<string, number> = new Map();
		const activeTurnChangeSet = this.stagingManager?.startTurn();

		const compiled = await this.contextCompiler.compile(
			userMessage,
			context,
			permissionMode,
		);
		rawContextUsed.push(...compiled.contextRefs);
		const fullUserPrompt = compiled.prompt;

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
				permissionMode,
				recordContext: (ref: ContextReference) => {
					rawContextUsed.push(ref);
				},
				recordReadMtime: (path: string, mtime: number) => {
					readMtimes.set(path, mtime);
				},
				getReadMtime: (path: string) => readMtimes.get(path),
			},
			{
				onToolStart: ({ callId, toolName, toolArgs }) => {
					void beforeTool?.();
					onStep?.({ type: 'tool_start', toolName, toolArgs, callId });
				},
				onToolEnd: ({ callId, toolName, toolOutput }) => {
					onStep?.({ type: 'tool_end', toolName, toolOutput, callId });
				},
			},
		);

		try {
			const result = await this.provider.runTurn(fullUserPrompt, media, {
				onThoughtDelta: (text) =>
					onStep?.({ type: 'thought_delta', text }),
				onAnswerDelta: (text) =>
					onStep?.({ type: 'answer_delta', text }),
				onToolStart: (toolName, toolArgs, callId) => {
					void beforeTool?.();
					onStep?.({
						type: 'tool_start',
						toolName,
						toolArgs,
						callId: callId ? `acp-${callId}` : undefined,
					});
				},
				onToolEnd: (toolName, toolOutput, callId) => {
					onStep?.({
						type: 'tool_end',
						toolName,
						toolOutput,
						callId: callId ? `acp-${callId}` : undefined,
					});
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
