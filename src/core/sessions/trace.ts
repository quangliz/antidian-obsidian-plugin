import type { AgentStepEvent } from '../agent';
import type {
	ReplayedAgentEvent,
	ReplayedMessage,
	StoredTurnTrace,
} from '../types/sessions';

type ToolEvent = Extract<ReplayedAgentEvent, { type: 'tool' }>;

/** Longest string kept verbatim in a saved tool result. */
export const TRACE_MAX_STRING_CHARS = 4000;
/** Field on a compacted record holding the true size of truncated strings. */
export const TRUNCATED_FIELD = '_truncated';

export interface TruncatedInfo {
	chars: number;
	lines: number;
}

/**
 * Collects a live turn's step events into the ordered trace that is saved and
 * later replayed (thoughts merged, tool start/end paired into one event).
 */
export class TurnTraceRecorder {
	private events: ReplayedAgentEvent[] = [];

	record(step: AgentStepEvent): void {
		if (step.type === 'thought_delta') {
			const last = this.events[this.events.length - 1];
			if (last && last.type === 'thought') last.text += step.text;
			else this.events.push({ type: 'thought', text: step.text });
		} else if (step.type === 'tool_start') {
			this.events.push({
				type: 'tool',
				callId: step.callId,
				toolName: step.toolName,
				toolArgs: step.toolArgs,
				status: 'in_progress',
			});
		} else if (step.type === 'tool_end') {
			const tools = this.events.filter((e): e is ToolEvent => e.type === 'tool');
			const match =
				(step.callId ? tools.find((t) => t.callId === step.callId) : undefined) ??
				tools.find(
					(t) => t.toolName === step.toolName && t.status === 'in_progress',
				);
			if (!match) return;
			const isError =
				!!step.toolOutput &&
				typeof step.toolOutput === 'object' &&
				'error' in step.toolOutput;
			match.status = isError ? 'failed' : 'completed';
			match.output = step.toolOutput;
		}
	}

	/** The trace with large tool results compacted, safe to persist. */
	snapshot(): ReplayedAgentEvent[] {
		return this.events.map((e) =>
			e.type === 'tool' && e.output !== undefined
				? { ...e, output: compactTraceValue(e.output) }
				: { ...e },
		);
	}
}

function lineCount(text: string): number {
	return text ? text.split('\n').length : 0;
}

/**
 * Bounds a tool result for storage: long strings are cut, and records note the
 * true size of each cut field under `_truncated` so summaries stay accurate.
 */
export function compactTraceValue(value: unknown, depth = 0): unknown {
	if (typeof value === 'string') {
		return value.length > TRACE_MAX_STRING_CHARS
			? `${value.slice(0, TRACE_MAX_STRING_CHARS)}…`
			: value;
	}
	if (depth > 8 || value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) {
		return value.slice(0, 200).map((v) => compactTraceValue(v, depth + 1));
	}
	const out: Record<string, unknown> = {};
	const truncated: Record<string, TruncatedInfo> = {};
	for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
		if (typeof v === 'string' && v.length > TRACE_MAX_STRING_CHARS) {
			truncated[key] = { chars: v.length, lines: lineCount(v) };
		}
		out[key] = compactTraceValue(v, depth + 1);
	}
	if (Object.keys(truncated).length > 0) out[TRUNCATED_FIELD] = truncated;
	return out;
}

/** True size of a string field that `compactTraceValue` may have cut. */
export function originalTextSize(
	record: Record<string, unknown>,
	key: string,
): TruncatedInfo | undefined {
	const t = record[TRUNCATED_FIELD];
	if (!t || typeof t !== 'object') return undefined;
	const info = (t as Record<string, unknown>)[key];
	if (!info || typeof info !== 'object') return undefined;
	const { chars, lines } = info as Record<string, unknown>;
	return typeof chars === 'number' && typeof lines === 'number'
		? { chars, lines }
		: undefined;
}

/**
 * Overlays Anti-dian's saved traces on the CLI's replay. Turns are aligned in
 * order by the typed user text; turns without a saved trace keep the replay.
 */
export function mergeStoredTraces(
	replayed: ReplayedMessage[],
	stored: StoredTurnTrace[],
): ReplayedMessage[] {
	const out: ReplayedMessage[] = replayed.map((m) => ({ ...m }));
	let next = 0;
	for (let i = 0; i < out.length; i++) {
		const msg = out[i]!;
		if (msg.role !== 'user') continue;
		const text = msg.text.trim();
		let found = -1;
		for (let k = next; k < stored.length; k++) {
			if (stored[k]!.userText.trim() === text) {
				found = k;
				break;
			}
		}
		if (found === -1) continue;
		next = found + 1;
		const trace = stored[found]!;

		if (trace.savedAt) {
			msg.timestamp = trace.savedAt;
		}

		let agent = out[i + 1];
		if (!agent || agent.role !== 'agent') {
			agent = { role: 'agent', text: '', events: [] };
			out.splice(i + 1, 0, agent);
		}
		if (trace.events.length > 0) agent.events = trace.events;
		agent.durationMs = trace.durationMs;
		agent.usage = trace.usage;
		if (trace.savedAt) {
			agent.timestamp = trace.savedAt;
		}
	}
	return out;
}

/** Validates untrusted JSON read back from disk. */
export function parseStoredTurns(raw: unknown): StoredTurnTrace[] {
	const turns =
		raw && typeof raw === 'object' && Array.isArray((raw as { turns?: unknown }).turns)
			? ((raw as { turns: unknown[] }).turns)
			: [];
	const out: StoredTurnTrace[] = [];
	for (const t of turns) {
		if (!t || typeof t !== 'object') continue;
		const r = t as Record<string, unknown>;
		if (typeof r.userText !== 'string' || !Array.isArray(r.events)) continue;
		const events = r.events.filter(isTraceEvent);
		out.push({
			userText: r.userText,
			events,
			durationMs: typeof r.durationMs === 'number' ? r.durationMs : undefined,
			usage: isUsage(r.usage) ? r.usage : undefined,
			cancelled: r.cancelled === true ? true : undefined,
			savedAt: typeof r.savedAt === 'string' ? r.savedAt : '',
		});
	}
	return out;
}

function isTraceEvent(e: unknown): e is ReplayedAgentEvent {
	if (!e || typeof e !== 'object') return false;
	const r = e as Record<string, unknown>;
	if (r.type === 'thought') return typeof r.text === 'string';
	return (
		r.type === 'tool' &&
		typeof r.toolName === 'string' &&
		!!r.toolArgs &&
		typeof r.toolArgs === 'object' &&
		!Array.isArray(r.toolArgs)
	);
}

function isUsage(u: unknown): u is StoredTurnTrace['usage'] {
	if (!u || typeof u !== 'object') return false;
	const r = u as Record<string, unknown>;
	return [
		'promptTokens',
		'candidatesTokens',
		'totalTokens',
		'cachedReadTokens',
		'cachedWriteTokens',
		'thoughtTokens',
	].every((k) => typeof r[k] === 'number');
}
