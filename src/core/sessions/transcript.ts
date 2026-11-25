import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
	extractForkedContext,
	stripCompiledContext,
	type ForkedTurn,
} from '../context/compiler';
import { LEGACY_PLUGIN_ID, stripMcpPrefix } from '../legacy-names';
import { resolveAppDataDir } from '../models/app-data-dir';
import { computeLineDiff, groupDiffHunks } from '../transactions/diff';
import type { ChangeOperationType, FileDiff } from '../types/changes';
import type { MediaInput } from '../types/model';
import type {
	ReplayedAgentEvent,
	ReplayedMessage,
	StoredTurnTrace,
	TurnUsage,
} from '../types/sessions';
import { compactTraceValue } from './trace';

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

interface TranscriptToolCall {
	name?: unknown;
	args?: unknown;
}

interface TranscriptStep {
	step_index?: unknown;
	source?: unknown;
	type?: unknown;
	status?: unknown;
	created_at?: unknown;
	content?: unknown;
	media?: unknown;
	thinking?: unknown;
	input_tokens?: unknown;
	cache_read_tokens?: unknown;
	output_tokens?: unknown;
	thought_tokens?: unknown;
	tool_calls?: unknown;
}

type ToolEvent = Extract<ReplayedAgentEvent, { type: 'tool' }>;

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function numOrZero(v: unknown): number {
	return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

function parseTimestampMs(raw: unknown): number | undefined {
	if (typeof raw !== 'string' || !raw.trim()) return undefined;
	const ms = Date.parse(raw.trim());
	return Number.isFinite(ms) ? ms : undefined;
}

/** How the CLI marks the context resource inside the text of a user request. */
const CONTEXT_MENTION_PATTERN = new RegExp(
	`@\\[[^\\]\\n]*(?:antidian|${LEGACY_PLUGIN_ID})[\\\\/]obsidian-context\\.md(?: \\(editor contents\\))?\\]`,
	'g',
);

function extractRawUserPrompt(rawContent: string): string {
	const tagMatch = rawContent.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
	return (tagMatch?.[1] ?? rawContent).replace(CONTEXT_MENTION_PATTERN, '');
}

/** Attached images of a USER_INPUT step, as `uri` references (not yet read). */
function parseTranscriptMedia(raw: unknown): MediaInput[] {
	if (!Array.isArray(raw)) return [];
	const out: MediaInput[] = [];
	for (const item of raw) {
		if (!isRecord(item)) continue;
		const { mime_type: mimeType, uri } = item;
		if (typeof mimeType !== 'string' || typeof uri !== 'string') continue;
		if (!/^image\/[\w.+-]+$/.test(mimeType)) continue;
		out.push({ type: 'image', mimeType, uri });
	}
	return out;
}

function parseTranscriptToolArgs(rawArgs: unknown): Record<string, unknown> {
	if (!isRecord(rawArgs)) return {};
	const out: Record<string, unknown> = {};
	for (const [key, val] of Object.entries(rawArgs)) {
		if (key === 'toolSummary') continue;
		if (typeof val === 'string') {
			try {
				out[key] = JSON.parse(val);
			} catch {
				out[key] = val;
			}
		} else {
			out[key] = val;
		}
	}
	return out;
}

function extractTruncatedOutputFilePath(rawContent: string): string | undefined {
	const match = rawContent.match(
		/You can find the full output in a file at (file:\/\/[^\s]+?)\.(?:\s|$)/,
	);
	const rawUri = match?.[1];
	if (!rawUri) return undefined;
	try {
		return fileURLToPath(rawUri);
	} catch {
		return undefined;
	}
}

function parseToolResultContent(
	rawContent: string,
	readStepOutput?: (filePath: string) => string | undefined,
): {
	output: unknown;
	completedAtMs?: number;
} {
	let body = rawContent;
	let completedAtMs: number | undefined;

	const completedMatch = body.match(/^Completed At:\s*(.+)$/m);
	if (completedMatch?.[1]) {
		completedAtMs = parseTimestampMs(completedMatch[1]);
	}

	// If agy spilled the full tool output to `steps/<n>/output.txt`, prefer it
	// so JSON parsing and true char/line counts remain exact.
	if (readStepOutput) {
		const spilledPath = extractTruncatedOutputFilePath(rawContent);
		if (spilledPath) {
			const fullText = readStepOutput(spilledPath);
			if (fullText !== undefined) {
				body = fullText;
				if (completedAtMs === undefined) {
					const m = body.match(/^Completed At:\s*(.+)$/m);
					if (m?.[1]) completedAtMs = parseTimestampMs(m[1]);
				}
			}
		}
	}

	// Strip leading `Created At:` / `Completed At:` metadata lines, and the notes
	// agy adds where a tool returned a file
	body = body
		.replace(/^\[Resource offloaded to file:\/\/.*\]$/gm, '')
		.replace(/^Created At:.*\r?\n/gm, '')
		.replace(/^Completed At:.*\r?\n/gm, '')
		.trim();

	// If agy wrapped a truncated preview and the full file wasn't available, unwrap the preview
	const previewMarker = 'Here is a preview with the middle of the output truncated:\n';
	const previewIdx = body.indexOf(previewMarker);
	if (previewIdx !== -1) {
		body = body
			.slice(previewIdx + previewMarker.length)
			.replace(/^Created At:.*\r?\n/gm, '')
			.replace(/^Completed At:.*\r?\n/gm, '')
			.trim();
	}

	if (!body) {
		return { output: undefined, completedAtMs };
	}

	try {
		const parsed: unknown = JSON.parse(body);
		return { output: compactTraceValue(parsed), completedAtMs };
	} catch {
		return { output: compactTraceValue(body), completedAtMs };
	}
}

function buildDiffFromTexts(
	notePath: string,
	operationType: ChangeOperationType,
	oldContent: string,
	newContent: string,
	heading?: string,
): FileDiff | undefined {
	const lines = computeLineDiff(oldContent, newContent);
	const hunks = groupDiffHunks(lines, {
		label: heading ? `# ${heading}` : undefined,
		showLineNumbers: operationType === 'create' || operationType === 'edit',
	});
	if (hunks.length === 0) return undefined;
	let additions = 0;
	let deletions = 0;
	for (const line of lines) {
		if (line.type === 'added') additions++;
		else if (line.type === 'removed') deletions++;
	}
	return {
		path: notePath,
		operationType,
		heading,
		oldContent,
		newContent,
		hunks,
		additions,
		deletions,
	};
}

/**
 * Reconstructs a `FileDiff` for a replayed mutating tool call from its recorded
 * arguments (since `_diff` is stripped before sending tool results to the model).
 */
function reconstructDiffFromToolArgs(
	toolName: string,
	args: Record<string, unknown>,
): FileDiff | undefined {
	const notePath = typeof args.path === 'string' ? args.path : '';
	if (!notePath) return undefined;

	switch (toolName) {
		case 'replace_block': {
			const oldText = typeof args.oldText === 'string' ? args.oldText : undefined;
			const newText = typeof args.newText === 'string' ? args.newText : undefined;
			if (oldText === undefined || newText === undefined) return undefined;
			return buildDiffFromTexts(notePath, 'replace-block', oldText, newText);
		}
		case 'create_note': {
			const content = typeof args.content === 'string' ? args.content : undefined;
			if (content === undefined) return undefined;
			return buildDiffFromTexts(notePath, 'create', '', content);
		}
		case 'append_note': {
			const content = typeof args.content === 'string' ? args.content : undefined;
			const heading = typeof args.heading === 'string' ? args.heading : undefined;
			if (content === undefined) return undefined;
			return buildDiffFromTexts(notePath, 'append', '', content, heading);
		}
		case 'patch_note': {
			const content = typeof args.content === 'string' ? args.content : undefined;
			const heading = typeof args.heading === 'string' ? args.heading : undefined;
			if (content === undefined) return undefined;
			return buildDiffFromTexts(notePath, 'patch-section', '', content, heading);
		}
		case 'edit_note': {
			const content = typeof args.content === 'string' ? args.content : undefined;
			if (content === undefined) return undefined;
			return buildDiffFromTexts(notePath, 'edit', '', content);
		}
		case 'update_frontmatter': {
			const setObj = isRecord(args.set) ? args.set : {};
			const removeList = Array.isArray(args.remove)
				? args.remove.filter((k): k is string => typeof k === 'string')
				: [];
			const oldLines = removeList.map((k) => `${k}: ...`).join('\n');
			const newLines = Object.entries(setObj)
				.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
				.join('\n');
			if (!oldLines && !newLines) return undefined;
			return buildDiffFromTexts(
				notePath,
				'update-frontmatter',
				oldLines,
				newLines,
				'frontmatter',
			);
		}
		default:
			return undefined;
	}
}

/**
 * Parses `agy`'s native `transcript_full.jsonl` / `transcript.jsonl` into
 * per-turn traces (tool calls, tool outputs, durations, and token usage) so
 * Antidian does not have to persist duplicate session files.
 */
export function parseAgyTranscriptJsonl(
	jsonlText: string,
	options?: { readStepOutput?: (filePath: string) => string | undefined },
): StoredTurnTrace[] {
	const turns: StoredTurnTrace[] = [];
	let current: {
		userText: string;
		media: MediaInput[];
		agentTextParts: string[];
		forkedContext?: ForkedTurn[];
		events: ReplayedAgentEvent[];
		startedAtMs?: number;
		endedAtMs?: number;
		hasUsage: boolean;
		usage: TurnUsage;
		savedAt: string;
	} | null = null;

	const finalizeCurrent = () => {
		if (!current) return;
		const durationMs =
			current.startedAtMs !== undefined && current.endedAtMs !== undefined
				? Math.max(0, current.endedAtMs - current.startedAtMs)
				: undefined;
		const agentText =
			current.agentTextParts.length > 0
				? current.agentTextParts.join('\n\n')
				: undefined;
		turns.push({
			userText: current.userText,
			...(current.media.length > 0 ? { media: current.media } : {}),
			...(agentText ? { agentText } : {}),
			...(current.forkedContext && current.forkedContext.length > 0
				? { forkedContext: current.forkedContext }
				: {}),
			events: current.events,
			durationMs,
			usage: current.hasUsage ? current.usage : undefined,
			savedAt: current.savedAt,
		});
		current = null;
	};

	const updateEnd = (ms?: number) => {
		if (!current || ms === undefined) return;
		if (current.endedAtMs === undefined || ms > current.endedAtMs) {
			current.endedAtMs = ms;
		}
	};

	for (const rawLine of jsonlText.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;

		let step: TranscriptStep;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!isRecord(parsed)) continue;
			step = parsed;
		} catch {
			continue;
		}

		const type = typeof step.type === 'string' ? step.type : '';
		const createdAtMs = parseTimestampMs(step.created_at);

		if (type === 'USER_INPUT') {
			finalizeCurrent();
			const rawContent = typeof step.content === 'string' ? step.content : '';
			const rawPrompt = extractRawUserPrompt(rawContent);
			const userText = stripCompiledContext(rawPrompt).trim();
			const media = parseTranscriptMedia(step.media);
			if (!userText && media.length === 0) continue;
			// The context resource is in the metadata after the request text.
			const forkedContext = extractForkedContext(rawContent);
			current = {
				userText,
				media,
				agentTextParts: [],
				forkedContext: forkedContext.length > 0 ? forkedContext : undefined,
				events: [],
				startedAtMs: createdAtMs,
				endedAtMs: createdAtMs,
				hasUsage: false,
				usage: {
					promptTokens: 0,
					candidatesTokens: 0,
					totalTokens: 0,
					cachedReadTokens: 0,
					cachedWriteTokens: 0,
					thoughtTokens: 0,
				},
				savedAt: typeof step.created_at === 'string' ? step.created_at : '',
			};
			continue;
		}

		if (!current) continue;
		updateEnd(createdAtMs);

		if (type === 'PLANNER_RESPONSE') {
			if (typeof step.thinking === 'string' && step.thinking.trim()) {
				current.events.push({ type: 'thought', text: step.thinking.trim() });
			}
			if (typeof step.content === 'string' && step.content.trim()) {
				current.agentTextParts.push(step.content.trim());
			}
			const inputTokens = numOrZero(step.input_tokens);
			const cachedRead = numOrZero(step.cache_read_tokens);
			const outputTokens = numOrZero(step.output_tokens);
			const thoughtTokens = numOrZero(step.thought_tokens);
			if (inputTokens > 0 || cachedRead > 0 || outputTokens > 0 || thoughtTokens > 0) {
				current.hasUsage = true;
				const promptTokens = inputTokens + cachedRead;
				current.usage.promptTokens += promptTokens;
				current.usage.candidatesTokens += outputTokens;
				current.usage.totalTokens += promptTokens + outputTokens;
				current.usage.cachedReadTokens += cachedRead;
				current.usage.thoughtTokens += thoughtTokens;
			}

			if (Array.isArray(step.tool_calls)) {
				for (const rawCall of step.tool_calls) {
					if (!isRecord(rawCall)) continue;
					const call = rawCall as TranscriptToolCall;
					if (typeof call.name !== 'string' || !call.name.trim()) continue;
					current.events.push({
						type: 'tool',
						toolName: stripMcpPrefix(call.name.trim()),
						toolArgs: parseTranscriptToolArgs(call.args),
						status: 'in_progress',
					});
				}
			}
			continue;
		}

		if (type === 'GENERIC') {
			const pendingTool = current.events.find(
				(e): e is ToolEvent => e.type === 'tool' && e.status === 'in_progress',
			);
			if (!pendingTool) continue;
			const rawContent = typeof step.content === 'string' ? step.content : '';
			const { output, completedAtMs } = parseToolResultContent(
				rawContent,
				options?.readStepOutput,
			);
			updateEnd(completedAtMs);
			const isError =
				step.status === 'ERROR' ||
				(isRecord(output) && 'error' in output && Boolean(output.error));
			pendingTool.status = isError ? 'failed' : 'completed';
			if (isRecord(output) && !('_diff' in output)) {
				const reconstructed = reconstructDiffFromToolArgs(
					pendingTool.toolName,
					pendingTool.toolArgs,
				);
				pendingTool.output = reconstructed
					? { ...output, _diff: reconstructed }
					: output;
			} else {
				pendingTool.output = output;
			}
		}
	}

	finalizeCurrent();

	// Mark any remaining in_progress tools as completed so replay never renders spinners
	for (const turn of turns) {
		for (const ev of turn.events) {
			if (ev.type === 'tool' && ev.status === 'in_progress') {
				ev.status = 'completed';
			}
		}
	}

	return turns;
}

/**
 * Candidate transcript files written by `agy` for a session, preferring the
 * untruncated `transcript_full.jsonl` over the compact `transcript.jsonl`.
 */
export function getAgyTranscriptPaths(
	sessionId: string,
	appDataDir: string = resolveAppDataDir(),
	homeDir: string = os.homedir(),
): string[] {
	if (!SESSION_ID_PATTERN.test(sessionId)) return [];
	const logsDir = path.join(
		homeDir,
		'.gemini',
		appDataDir,
		'brain',
		sessionId,
		'.system_generated',
		'logs',
	);
	return [
		path.join(logsDir, 'transcript_full.jsonl'),
		path.join(logsDir, 'transcript.jsonl'),
	];
}

function createScopedStepOutputReader(
	sessionId: string,
	appDataDir: string,
	homeDir: string,
): (filePath: string) => string | undefined {
	const allowedRoot = path.resolve(
		homeDir,
		'.gemini',
		appDataDir,
		'brain',
		sessionId,
		'.system_generated',
		'steps',
	);
	const allowedPrefix = `${allowedRoot}${path.sep}`;

	return (filePath: string): string | undefined => {
		const resolved = path.resolve(filePath);
		if (!resolved.startsWith(allowedPrefix)) return undefined;
		try {
			return fs.readFileSync(resolved, 'utf8');
		} catch {
			return undefined;
		}
	};
}

/**
 * Reads attached images into data URLs. Only files in this session's own
 * `.user_uploaded` folder are read; unreadable ones keep `data` unset.
 */
async function loadTurnMedia(
	turns: StoredTurnTrace[],
	sessionId: string,
	appDataDir: string,
	homeDir: string,
): Promise<void> {
	const allowedPrefix =
		path.resolve(
			homeDir,
			'.gemini',
			appDataDir,
			'brain',
			sessionId,
			'.user_uploaded',
		) + path.sep;
	await Promise.all(
		turns
			.flatMap((turn) => turn.media ?? [])
			.map(async (item) => {
				const resolved = path.resolve(item.uri ?? '');
				if (!resolved.startsWith(allowedPrefix)) return;
				try {
					const base64 = await fs.promises.readFile(resolved, 'base64');
					item.data = `data:${item.mimeType};base64,${base64}`;
				} catch {
					// File is gone: the message is still shown, without its image
				}
			}),
	);
}

/**
 * Loads per-turn tool results, durations, usage, and attached images directly
 * from `agy`'s own session transcript logs on disk.
 */
export async function loadAgyTranscriptTurns(
	sessionId: string,
	appDataDir: string = resolveAppDataDir(),
	homeDir: string = os.homedir(),
): Promise<StoredTurnTrace[]> {
	const paths = getAgyTranscriptPaths(sessionId, appDataDir, homeDir);
	if (paths.length === 0) return [];
	const readStepOutput = createScopedStepOutputReader(
		sessionId,
		appDataDir,
		homeDir,
	);
	for (const filePath of paths) {
		try {
			const text = await fs.promises.readFile(filePath, 'utf8');
			const turns = parseAgyTranscriptJsonl(text, { readStepOutput });
			await loadTurnMedia(turns, sessionId, appDataDir, homeDir);
			return turns;
		} catch {
			// Try next candidate
		}
	}
	return [];
}

/** Converts plain forked context turns (fallback when parent logs are absent) into replay messages. */
export function forkedTurnsToReplayedMessages(
	turns: ForkedTurn[],
): ReplayedMessage[] {
	const messages: ReplayedMessage[] = [];
	for (const turn of turns) {
		if (turn.userText) {
			messages.push({ role: 'user', text: turn.userText });
		}
		if (turn.agentText) {
			messages.push({ role: 'agent', text: turn.agentText });
		}
	}
	return messages;
}

/**
 * Safely deletes local `agy` session files (`brain/<id>` and `conversations/<id>.db*`)
 * inside Antidian's isolated app-data directory.
 */
export async function deleteAgySessionData(
	sessionId: string,
	appDataDir: string = resolveAppDataDir(),
	homeDir: string = os.homedir(),
): Promise<void> {
	if (!SESSION_ID_PATTERN.test(sessionId)) return;
	const baseDir = path.join(homeDir, '.gemini', appDataDir);
	const targets = [
		path.join(baseDir, 'brain', sessionId),
		path.join(baseDir, 'conversations', `${sessionId}.db`),
		path.join(baseDir, 'conversations', `${sessionId}.db-wal`),
		path.join(baseDir, 'conversations', `${sessionId}.db-shm`),
	];
	await Promise.all(
		targets.map((target) =>
			fs.promises.rm(target, { recursive: true, force: true }).catch(() => {}),
		),
	);
}
