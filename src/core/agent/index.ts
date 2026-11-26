import type { ActiveContext, ContextReference } from '../types/context';
import type { Message, MediaInput } from '../types/model';
import type { ChangeSet } from '../types/changes';
import type { ElicitationHandler } from '../types/elicitation';
import type { PlanStep } from '../types/plan';
import { parseFocusText } from '../models/plan';
import { type HarnessPermissionMode, type Tool, ToolRegistry } from '../tools';
import type { ApprovalHandler, ChangeStagingManager, MutationGate } from '../transactions';
import {
	COMPACTED_REPLY,
	ContextCompiler,
	type ForkedTurn,
	isCompactCommand,
	stripCompiledContext,
} from '../context/compiler';
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
	| { type: 'plan_update'; steps: PlanStep[] }
	| { type: 'focus_update'; focus: string }
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

export const DEFAULT_AGENT_SYSTEM_PROMPT = `You are Antidian, an intelligent note-taking and knowledge harness running inside Obsidian.

Tool rules (strict):
- ALWAYS use the \`antidian-vault\` MCP tools for every vault operation.
- NEVER invoke built-in filesystem, editor, or shell tools (such as read_file, edit_file, write_file, run_command, grep, find) to access or modify vault notes — they are blocked by Obsidian's safety boundary. The only exceptions, both with \`read_file\`: the exact file a \`read_note\` result says it was offloaded to, and a skill's \`SKILL.md\` plus the files it references.
- Built-in web search (\`search_web\`) may be used when external information is needed.
- Built-in \`ask_question\` may be used to present interactive multiple-choice questions when clarifying requirements, preferences, or options with the user (use plain text for trivial yes/no questions).

Progress tracking (for multi-step work):
- Whenever a request involves 3 or more distinct steps (for example: finding and reading multiple notes, comparing or synthesizing across notes, planning, or editing multiple sections/notes), call built-in \`update_steps\` IN PARALLEL with your first tool call to show a concise 3–6 step checklist (first step \`in_progress\`, remaining \`pending\`). Update it as you move between phases and mark every step \`done\` before your final answer.
- Call \`update_focus\` in parallel with the first tool call of each phase to display a concise live status phrase (3–8 words, in the user's language) describing what you are currently doing.
- Skip \`update_steps\` and \`update_focus\` for simple 1–2 step lookups or direct questions.

Recommended vault workflow:
1. Act directly when the target note and its relevant content are already in context or earlier turns; only call \`list_notes\` or \`search_notes\` when you need to discover unknown notes or find related notes. For long unread notes, prefer \`get_note_outline\` (headings, frontmatter, tags, links, backlinks) before reading in full with \`read_note\`. \`read_note\` also opens images, PDFs, audio, video, and Office documents (docx, xlsx, pptx).
2. Prefer structural edits over whole-file rewrites:
   - \`replace_block\` for localized exact-text edits
   - \`patch_note\` for replacing a specific heading section
   - \`append_note\` for adding content to the end of a note or under a heading
   - \`update_frontmatter\` for setting or removing YAML properties
   - \`create_note\` for new notes, and \`edit_note\` only when a full-file rewrite is truly needed.
3. Each write tool call is reviewed on its own. In Auto mode it is applied before the tool returns (\`applied: true\`). In Ask mode the tool returns at once with \`pendingApproval: true\`: the user is shown the change, and it is not in the vault until they approve it. Don't retry it or edit that file again until it is decided (such edits are refused); continue other work or finish your answer, saying the change awaits the user's approval. Decisions arrive later in a tool result or with the user's next message; if a change was rejected, don't retry it — ask the user instead. \`read_note\` and \`get_note_outline\` reflect applied edits only.
4. Use a skill only when it matches the request or the user invokes it with \`/name\`. Skills cannot run scripts or shell commands here, and their vault edits still go through the \`antidian-vault\` tools.
5. In Plan Mode (read-only), do not call write tools; present your analysis and proposed edits in markdown.

Context from Obsidian (active note, selection, mode) is attached as \`obsidian-context.md\`. It is not a vault file: never open, cite, or edit it.

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
		this.mutationGate?.forgetDecisions();
	}

	/** Starts a new session seeded with turns from a parent conversation. */
	async forkSession(turns: ForkedTurn[]): Promise<void> {
		this.cancel();
		await this.provider.resetSession();
		this.mutationGate?.forgetDecisions();
		this.contextCompiler.seedForkedHistory(turns);
	}

	async listSessions(): Promise<AcpSessionSummary[]> {
		return this.provider.listSessions();
	}

	/**
	 * Continues a stored session. Returns its history with Antidian's injected
	 * context blocks removed from user messages, ready for display.
	 */
	async loadSession(sessionId: string): Promise<ReplayedMessage[]> {
		this.cancel();
		const replayed = await this.provider.loadSession(sessionId);
		this.mutationGate?.forgetDecisions();
		this.contextCompiler.reset();
		const messages = replayed
			.map((m) =>
				m.role === 'user' ? { ...m, text: stripCompiledContext(m.text) } : m,
			)
			.filter(
				(m) => m.text.trim().length > 0 || (m.events?.length ?? 0) > 0,
			);
		const last = messages[messages.length - 1];
		if (last?.role === 'user' && isCompactCommand(last.text)) {
			messages.push({ role: 'agent', text: COMPACTED_REPLY, events: [] });
		}
		return messages;
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
		requestElicitation?: ElicitationHandler,
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
		// Ask-mode decisions made after the last turn ended reach the model here.
		const reviewNotes = isCompactCommand(userMessage)
			? undefined
			: this.mutationGate?.takeReviewNotes({ includeAwaiting: true });
		const turnContextText =
			[compiled.context, reviewNotes].filter(Boolean).join('\n\n') || undefined;

		const currentMessages: Message[] = [
			...history,
			{
				role: 'user',
				text: userMessage,
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
									// The tool already returned a pending result; update its row.
									onDecided: (callId, toolOutput) =>
										onStep?.({ type: 'tool_end', toolName: call.toolName, toolOutput, callId }),
								})
						: undefined,
				takeReviewNotes: () => this.mutationGate?.takeReviewNotes(),
			},
			{
				onToolStart: ({ callId, toolName, toolArgs }) => {
					if (toolName === 'update_focus') {
						const focus = parseFocusText(toolArgs);
						if (focus) onStep?.({ type: 'focus_update', focus });
						return;
					}
					void beforeTool?.();
					onStep?.({ type: 'tool_start', toolName, toolArgs, callId });
				},
				onToolEnd: ({ callId, toolName, toolOutput }) => {
					if (toolName === 'update_focus') return;
					onStep?.({ type: 'tool_end', toolName, toolOutput, callId });
				},
			},
		);

		try {
			const result = await this.provider.runTurn(
				userMessage,
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
					onElicitation: requestElicitation,
					onPlanUpdate: (steps) =>
						onStep?.({ type: 'plan_update', steps }),
					onFocusUpdate: (focus) =>
						onStep?.({ type: 'focus_update', focus }),
				},
				turnController.signal,
				turnContextText,
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
