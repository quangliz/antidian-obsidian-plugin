/**
 * Session history contracts: what a stored conversation replays as, and the
 * per-turn trace Anti-dian keeps itself (the CLI does not persist reasoning
 * text, MCP tool results, durations, or per-turn token usage).
 */

/** Reasoning or a tool call inside an agent turn, in original order. */
export type ReplayedAgentEvent =
	| { type: 'thought'; text: string }
	| {
			type: 'tool';
			callId?: string;
			/** Display name (the `anti-dian-vault` MCP prefix is stripped). */
			toolName: string;
			toolArgs: Record<string, unknown>;
			/** `completed` / `failed`, or unfinished (`pending`, `in_progress`). */
			status?: string;
			/** Result as live tool events carry it; undefined when it was not stored. */
			output?: unknown;
	  };

export interface TurnUsage {
	promptTokens: number;
	candidatesTokens: number;
	totalTokens: number;
	cachedReadTokens: number;
	cachedWriteTokens: number;
	thoughtTokens: number;
}

/** One message of a stored conversation, ready for display. */
export interface ReplayedMessage {
	role: 'user' | 'agent';
	/** User prompt, or the agent's answer text. */
	text: string;
	/** ISO timestamp when this message was created, when known. */
	timestamp?: string;
	/** Agent turns only: reasoning and tool calls that preceded the answer. */
	events?: ReplayedAgentEvent[];
	/** Agent turns only, from Anti-dian's own trace when one was saved. */
	durationMs?: number;
	usage?: TurnUsage;
}

/** Anti-dian's record of one finished turn, saved alongside the CLI session. */
export interface StoredTurnTrace {
	/** The text the user typed (without injected context); used to align with the replay. */
	userText: string;
	events: ReplayedAgentEvent[];
	durationMs?: number;
	usage?: TurnUsage;
	cancelled?: boolean;
	savedAt: string;
}

/** Persists per-turn traces by ACP session id. */
export interface SessionTraceStore {
	loadTurns(sessionId: string): Promise<StoredTurnTrace[]>;
	appendTurn(sessionId: string, turn: StoredTurnTrace): Promise<void>;
}
