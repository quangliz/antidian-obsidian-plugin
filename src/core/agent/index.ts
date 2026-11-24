import type { ActiveContext, ContextReference } from '../types/context';
import type { Message, MediaInput } from '../types/model';
import type { ChangeSet } from '../types/changes';
import { type HarnessPermissionMode, type Tool, ToolRegistry } from '../tools';
import type { ApprovalHandler, ChangeStagingManager, MutationGate } from '../transactions';
import { ContextCompiler, stripCompiledContext } from '../context/compiler';
import type { AntigravityProvider } from '../models/antigravity-provider';
import type {
	AcpSessionSummary,
	ReplayedMessage,
} from '../models/antigravity-acp';

export interface AgentOptions {
	provider: AntigravityProvider;
	tools?: ToolRegistry | Tool[];
	stagingManager?: ChangeStagingManager;
	/** Reviews each staged mutation per tool call (ask/auto modes). */
	mutationGate?: MutationGate;
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
	| { type: 'cancelled' }
	| { type: 'error'; message: string };

export interface AgentRunResult {
	answer: string;
	cancelled?: boolean;
	updatedHistory: Message[];
	contextUsed: ContextReference[];
	changeSet?: ChangeSet;
	usage?: {
		promptTokens: number;
		candidatesTokens: number;
		totalTokens: number;
		cachedReadTokens: number;
		cachedWriteTokens: number;
		thoughtTokens: number;
	};
}

export const DEFAULT_AGENT_SYSTEM_PROMPT = `You are Anti-dian, an intelligent note-taking and knowledge harness running inside Obsidian.

Tool rules (strict):
- ALWAYS use the \`anti-dian-vault\` MCP tools for every vault operation.
- NEVER invoke built-in filesystem, editor, or shell tools (such as read_file, edit_file, write_file, run_command, grep, find) to access or modify vault notes — they are blocked by Obsidian's safety boundary.
- Built-in web search (\`search_web\`) may be used when external information is needed.

Recommended vault workflow:
1. Act directly when the target note and its relevant content are already in context or earlier turns; only call \`list_notes\` or \`search_notes\` when you need to discover unknown notes or find related notes. For long unread notes, prefer \`get_note_outline\` (headings, frontmatter, tags, links, backlinks) before reading in full with \`read_note\`.
2. Prefer structural edits over whole-file rewrites:
   - \`replace_block\` for localized exact-text edits
   - \`patch_note\` for replacing a specific heading section
   - \`append_note\` for adding content to the end of a note or under a heading
   - \`update_frontmatter\` for setting or removing YAML properties
   - \`create_note\` for new notes, and \`edit_note\` only when a full-file rewrite is truly needed.
3. Each write tool call is reviewed immediately: in Ask mode the user approves or rejects it before the tool returns. The result says whether it was applied (\`applied: true\`) or rejected (\`rejectedByUser: true\`); if rejected, don't retry the same edit — ask the user instead. \`read_note\` and \`get_note_outline\` reflect applied and staged edits.
4. Available vault skills are already injected into session context when present. Only call \`load_skill\` if a listed skill matches the request; do not call \`list_skills\` unless the user asks to inspect or refresh skills.
5. In Plan Mode (read-only), do not call write tools; present your analysis and proposed edits in markdown.

Formatting:
- Cite vault notes as plain wikilinks, e.g. [[Note Name]] or [[Note Name#Heading]]. Never put wikilinks inside backticks or code formatting, or they won't be clickable.
- Keep responses helpful, accurate, and concise.`;

export class Agent {
	private provider: AntigravityProvider;
	private registry: ToolRegistry;
	private stagingManager?: ChangeStagingManager;
	private mutationGate?: MutationGate;
	private contextCompiler: ContextCompiler;
	private activeTurnController: AbortController | null = null;

	constructor(options: AgentOptions) {
		this.provider = options.provider;
		this.stagingManager = options.stagingManager;
		this.mutationGate = options.mutationGate;
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

	cancel(): void {
		this.activeTurnController?.abort();
		this.provider.cancel();
	}

	async resetSession(): Promise<void> {
		this.cancel();
		this.contextCompiler.reset();
		await this.provider.resetSession();
	}

	async listSessions(): Promise<AcpSessionSummary[]> {
		return this.provider.listSessions();
	}

	/**
	 * Continues a stored session. Returns its history with Anti-dian's injected
	 * context blocks removed from user messages, ready for display.
	 */
	async loadSession(sessionId: string): Promise<ReplayedMessage[]> {
		this.cancel();
		const replayed = await this.provider.loadSession(sessionId);
		this.contextCompiler.resumeSession();
		return replayed
			.map((m) =>
				m.role === 'user' ? { ...m, text: stripCompiledContext(m.text) } : m,
			)
			.filter((m) => m.text.trim().length > 0);
	}

	async run(
		userMessage: string,
		context?: ActiveContext,
		history: Message[] = [],
		onStep?: (event: AgentStepEvent) => void,
		media?: MediaInput[],
		beforeTool?: () => Promise<void>,
		permissionMode: HarnessPermissionMode = 'ask',
		requestApproval?: ApprovalHandler,
		signal?: AbortSignal,
	): Promise<AgentRunResult> {
		const rawContextUsed: ContextReference[] = [];
		const readMtimes: Map<string, number> = new Map();
		const activeTurnChangeSet = this.stagingManager?.startTurn();

		const turnController = new AbortController();
		this.activeTurnController = turnController;
		const onExternalAbort = () => turnController.abort();
		if (signal) {
			if (signal.aborted) {
				turnController.abort();
			} else {
				signal.addEventListener('abort', onExternalAbort, { once: true });
			}
		}

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

		if (turnController.signal.aborted) {
			if (this.activeTurnController === turnController) {
				this.activeTurnController = null;
			}
			signal?.removeEventListener('abort', onExternalAbort);
			onStep?.({ type: 'cancelled' });
			return {
				answer: '',
				cancelled: true,
				updatedHistory: currentMessages,
				contextUsed: this.deduplicateContext(rawContextUsed),
			};
		}

		onStep?.({ type: 'thinking' });
		onStep?.({ type: 'answer_start' });

		const mcpServer = this.provider.getMcpToolServer();
		mcpServer?.setTurnContext(
			{
				context,
				permissionMode,
				signal: turnController.signal,
				recordContext: (ref: ContextReference) => {
					rawContextUsed.push(ref);
				},
				recordReadMtime: (path: string, mtime: number) => {
					readMtimes.set(path, mtime);
				},
				getReadMtime: (path: string) => readMtimes.get(path),
				reviewMutation:
					this.mutationGate && permissionMode !== 'plan'
						? (call) =>
								this.mutationGate!.review(call, {
									mode: permissionMode === 'auto' ? 'auto' : 'ask',
									requestApproval,
									recordReadMtime: (path, mtime) => readMtimes.set(path, mtime),
								})
						: undefined,
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
			const result = await this.provider.runTurn(
				fullUserPrompt,
				media,
				{
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
				},
				turnController.signal,
			);

			const contextUsed = this.deduplicateContext(rawContextUsed);
			const finalChangeSet =
				activeTurnChangeSet && activeTurnChangeSet.operations.length > 0
					? activeTurnChangeSet
					: undefined;

			const usage = result.usage
				? {
						promptTokens: result.usage.promptTokens ?? 0,
						candidatesTokens: result.usage.candidatesTokens ?? 0,
						totalTokens:
							result.usage.totalTokens ??
							(result.usage.promptTokens ?? 0) +
								(result.usage.candidatesTokens ?? 0),
						cachedReadTokens: result.usage.cachedReadTokens ?? 0,
						cachedWriteTokens: result.usage.cachedWriteTokens ?? 0,
						thoughtTokens: result.usage.thoughtTokens ?? 0,
					}
				: undefined;

			if (result.stopReason === 'cancelled' || turnController.signal.aborted) {
				onStep?.({ type: 'cancelled' });
				if (result.answer) {
					currentMessages.push({
						role: 'assistant',
						text: result.answer,
					});
				}
				return {
					answer: result.answer,
					cancelled: true,
					updatedHistory: currentMessages,
					contextUsed,
					changeSet: finalChangeSet,
					usage,
				};
			}

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

			return {
				answer: result.answer,
				updatedHistory: currentMessages,
				contextUsed,
				changeSet: finalChangeSet,
				usage,
			};
		} catch (err) {
			if (turnController.signal.aborted) {
				onStep?.({ type: 'cancelled' });
				return {
					answer: '',
					cancelled: true,
					updatedHistory: currentMessages,
					contextUsed: this.deduplicateContext(rawContextUsed),
				};
			}
			const errMsg = err instanceof Error ? err.message : String(err);
			onStep?.({ type: 'error', message: errMsg });
			return {
				answer: `Error communicating with Antigravity CLI: ${errMsg}`,
				updatedHistory: currentMessages,
				contextUsed: this.deduplicateContext(rawContextUsed),
			};
		} finally {
			if (this.activeTurnController === turnController) {
				this.activeTurnController = null;
			}
			signal?.removeEventListener('abort', onExternalAbort);
			mcpServer?.clearTurnContext();
		}
	}

	private deduplicateContext(
		refs: ContextReference[],
	): ContextReference[] {
		const seen = new Set<string>();
		const result: ContextReference[] = [];

		for (const ref of refs) {
			// The editor selection is its own reference, not a duplicate of the note.
			const kind = ref.reason === 'Selection' ? '#selection' : '';
			const key = `${ref.path}#${ref.heading ?? ''}${kind}`;
			if (!seen.has(key)) {
				seen.add(key);
				result.push(ref);
			}
		}

		return result;
	}
}
