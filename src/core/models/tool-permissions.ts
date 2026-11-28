import * as os from 'os';
import * as path from 'path';
import { MCP_SERVER_NAME, stripMcpPrefix } from '../legacy-names';
import type { BlockedTool, BlockedToolReason } from '../types/permissions';

/**
 * Decides `agy`'s `session/request_permission` requests (pure apart from
 * `path`/`os`; unit-tested). A request is allowed, refused by policy, or put to
 * the user. `agy` ends the turn when a tool is refused, so only what must never
 * run is refused outright: built-in file access to the vault (which goes through
 * the `antidian-vault` tools), built-in file writes, and shell commands.
 */

/** Built-in tools that never touch local files. */
const SAFE_BUILTIN_TOOLS = new Set([
	'search_web',
	'web_search',
	'google_search',
	'read_url_content',
	'view_content_chunk',
	'ask_question',
	'update_steps',
	'update_focus',
]);

/** Built-in tools that read one file. */
const FILE_READ_TOOLS = new Set(['read_file', 'view_file']);

/** Built-in tools that list or search a folder. */
const FOLDER_READ_TOOLS = new Set(['list_dir', 'list_directory', 'find_by_name', 'grep_search']);

/** Built-in tools that write files: writes are staged by the `antidian-vault` tools. */
const WRITE_TOOLS = new Set([
	'write_to_file',
	'write_file',
	'replace_file_content',
	'multi_replace_file_content',
	'edit_file',
	'create_file',
	'delete_file',
]);

const SHELL_TOOLS = new Set(['run_command', 'send_command_input', 'command_status', 'read_terminal']);

/** Argument names `agy`'s built-in tools use for a file or folder path. */
const PATH_ARG_KEYS = [
	'Path',
	'path',
	'AbsolutePath',
	'absolutePath',
	'FilePath',
	'filePath',
	'file_path',
	'TargetFile',
	'targetFile',
	'DirectoryPath',
	'directoryPath',
	'SearchDirectory',
	'searchDirectory',
	'SearchPath',
	'searchPath',
];

/**
 * The folders the model may read from with `agy`'s built-in file tools: the
 * vault's and the user's skill folders (`~/.gemini/config/skills` is where
 * `agy` keeps global skills), `agy`'s MCP tool schemas
 * (`<appDataDir>/mcp/<server>/<tool>.json`), and the current session's
 * `.system_generated` folder (large tool outputs offloaded to `steps/<n>/output.txt`).
 */
export function readFileRoots(
	vaultPath: string,
	appDataDir: string,
	homeDir: string = os.homedir(),
	sessionId?: string | null,
): string[] {
	const roots = [
		path.join(vaultPath, '.agents', 'skills'),
		path.join(homeDir, '.agents', 'skills'),
		path.join(homeDir, '.gemini', 'config', 'skills'),
		path.join(homeDir, '.gemini', appDataDir, 'mcp'),
	];
	if (
		typeof sessionId === 'string' &&
		sessionId.length > 0 &&
		!/[/\\]/.test(sessionId) &&
		sessionId !== '.' &&
		sessionId !== '..'
	) {
		roots.push(
			path.join(homeDir, '.gemini', appDataDir, 'brain', sessionId, '.system_generated'),
		);
	}
	return roots;
}

/**
 * An absolute path with forward slashes, from a path or a `file://` URI (`agy`
 * names offloaded outputs with one). Null for relative paths, `.`/`..`
 * segments, and anything that is not a string.
 */
export function toAbsolutePath(value: unknown): string | null {
	if (typeof value !== 'string' || value.includes('\0')) return null;
	let p = value.trim();
	if (/^file:\/\//i.test(p)) {
		p = p.slice('file://'.length);
		try {
			p = decodeURIComponent(p);
		} catch {
			return null;
		}
		if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
	}
	p = p.replace(/\\/g, '/');
	if (!p.startsWith('/') && !/^[A-Za-z]:\//.test(p)) return null;
	if (p.length > 1) p = p.replace(/\/+$/, '');
	const segments = p.split('/');
	if (segments.includes('..') || segments.includes('.')) return null;
	return p;
}

/**
 * Whether `file` (from `toAbsolutePath`) is `root` or below it, with at least
 * `minDepth` non-empty segments below.
 */
export function isPathInside(
	file: string,
	root: string,
	minDepth: number,
	ignoreCase = false,
): boolean {
	const fold = (s: string) => (ignoreCase ? s.toLowerCase() : s);
	const base = fold(root.replace(/\\/g, '/').replace(/\/+$/, ''));
	const target = fold(file);
	if (target === base) return minDepth === 0;
	if (!target.startsWith(`${base}/`)) return false;
	const rest = target.slice(base.length + 1).split('/');
	return rest.length >= minDepth && rest.every((segment) => segment.length > 0);
}

/** Whether an agy `call_mcp_tool` call targets Antidian's own vault server. */
export function isVaultMcpServer(rawInput: Record<string, unknown> | undefined): boolean {
	const server = rawInput?.ServerName ?? rawInput?.serverName ?? rawInput?.server;
	return typeof server === 'string' && server.includes(MCP_SERVER_NAME);
}

export interface ToolPermissionContext {
	vaultPath: string;
	/** From `readFileRoots`. */
	readRoots: readonly string[];
	/** True in read-only Plan mode. */
	planMode: boolean;
	/** MCP servers given to `agy` by name, to show `mcp_<server>_<tool>` as `server/tool`. */
	mcpServerNames?: readonly string[];
}

export type ToolPermissionVerdict =
	| { kind: 'allow' }
	| { kind: 'deny'; reason: Extract<BlockedToolReason, 'vault' | 'write' | 'shell'> }
	| {
			kind: 'ask';
			/** Calls with the same key are covered by "Allow for this session". */
			sessionKey: string;
			/** What that covers, for display. */
			sessionScope: string;
			target?: string;
	  };

/** Decides a permission request for tool `rawName` (as agy names it) called with `rawInput`. */
export function classifyToolPermission(
	rawName: string,
	rawInput: Record<string, unknown> | undefined,
	ctx: ToolPermissionContext,
): ToolPermissionVerdict {
	const name = rawName.trim();
	// The vault server enforces the permission mode itself.
	if (
		name.includes(MCP_SERVER_NAME) ||
		stripMcpPrefix(name) !== name ||
		(name === 'call_mcp_tool' && isVaultMcpServer(rawInput))
	) {
		return { kind: 'allow' };
	}

	// MCP servers the user set up (mcp_config.json, companion plugins) are
	// trusted, but may change things outside the vault: asked in Plan mode.
	const mcpTarget = mcpToolLabel(name, rawInput, ctx.mcpServerNames ?? []);
	if (mcpTarget) {
		if (!ctx.planMode) return { kind: 'allow' };
		return {
			kind: 'ask',
			sessionKey: `mcp:${mcpTarget}`,
			sessionScope: `${mcpTarget} for this session`,
			target: mcpTarget,
		};
	}

	if (SAFE_BUILTIN_TOOLS.has(name)) return { kind: 'allow' };
	if (WRITE_TOOLS.has(name)) return { kind: 'deny', reason: 'write' };
	if (SHELL_TOOLS.has(name)) return { kind: 'deny', reason: 'shell' };

	const rawPaths = pathArgs(rawInput);
	const paths = rawPaths.map(toAbsolutePath);
	const isFileTool = FILE_READ_TOOLS.has(name);
	const isFolderTool = FOLDER_READ_TOOLS.has(name);
	if ((isFileTool || isFolderTool) && paths.length > 0) {
		// Relative paths resolve against the vault.
		if (paths.some((p) => p === null)) return { kind: 'deny', reason: 'vault' };
		const absolute = paths as string[];
		const minDepth = isFileTool ? 2 : 0;
		if (absolute.every((p) => ctx.readRoots.some((root) => isPathInside(p, root, minDepth)))) {
			return { kind: 'allow' };
		}
	}

	// Built-in tools never reach vault files, whatever they are.
	const absolute = paths.filter((p): p is string => p !== null);
	const inVault = absolute.some(
		(p) =>
			isPathInside(p, ctx.vaultPath, 0, true) &&
			!ctx.readRoots.some((root) => isPathInside(p, root, 0)),
	);
	if (inVault) return { kind: 'deny', reason: 'vault' };

	const first = absolute[0];
	if ((isFileTool || isFolderTool) && first) {
		const folder = isFileTool ? parentFolder(first) : first;
		return {
			kind: 'ask',
			sessionKey: `${name}:${folder}`,
			sessionScope: `${name} in ${folder} for this session`,
			target: absolute.join(', '),
		};
	}

	// Any other built-in (browser, image generation, …): the user decides.
	return {
		kind: 'ask',
		sessionKey: `tool:${name}`,
		sessionScope: `${name} for this session`,
		target: first ?? stringArg(rawInput, ['Url', 'url', 'Query', 'query']),
	};
}

function mcpToolLabel(
	name: string,
	rawInput: Record<string, unknown> | undefined,
	serverNames: readonly string[],
): string | null {
	if (name === 'call_mcp_tool') {
		const server = stringArg(rawInput, ['ServerName', 'serverName', 'server']) ?? 'unknown server';
		const tool = stringArg(rawInput, ['ToolName', 'toolName', 'tool']) ?? 'unknown tool';
		return `${server}/${tool}`;
	}
	const double = /^mcp__(.+?)__(.+)$/.exec(name);
	if (double) return `${double[1]}/${double[2]}`;
	if (!name.startsWith('mcp_') || name.length <= 'mcp_'.length) return null;
	const rest = name.slice('mcp_'.length);
	const server = serverNames.find((s) => rest.startsWith(`${s}_`));
	return server ? `${server}/${rest.slice(server.length + 1)}` : rest;
}

function pathArgs(rawInput: Record<string, unknown> | undefined): unknown[] {
	if (!rawInput) return [];
	return PATH_ARG_KEYS.filter((key) => rawInput[key] !== undefined && rawInput[key] !== '').map(
		(key) => rawInput[key],
	);
}

function stringArg(
	rawInput: Record<string, unknown> | undefined,
	keys: readonly string[],
): string | undefined {
	for (const key of keys) {
		const value = rawInput?.[key];
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return undefined;
}

function parentFolder(file: string): string {
	const index = file.lastIndexOf('/');
	if (index <= 0) return '/';
	const parent = file.slice(0, index);
	return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent;
}

const BLOCK_REASON_TEXT: Record<BlockedToolReason, (names: string) => string> = {
	vault: (names) =>
		`Antidian blocked ${names}: built-in file tools cannot open vault files (the antidian-vault tools can).`,
	write: (names) =>
		`Antidian blocked ${names}: built-in tools cannot write files. Edits go through the antidian-vault tools, so you can review and undo them.`,
	shell: (names) => `Antidian blocked ${names}: shell commands are not available in Antidian.`,
	user: (names) => `You denied ${names}.`,
	unanswered: (names) => `${names} needed your permission, but nothing could ask for it.`,
};

function formatToolNames(names: readonly string[]): string {
	return names.map((n) => `\`${n}\``).join(', ');
}

/** Explains refused tool calls, grouped by reason (pure). */
export function describeBlockedTools(blocked: readonly BlockedTool[]): string | undefined {
	if (blocked.length === 0) return undefined;
	const byReason = new Map<BlockedToolReason, string[]>();
	for (const { name, reason } of blocked) {
		const names = byReason.get(reason) ?? [];
		if (!names.includes(name)) names.push(name);
		byReason.set(reason, names);
	}
	const sentences = [...byReason].map(([reason, names]) =>
		BLOCK_REASON_TEXT[reason](formatToolNames(names)),
	);
	return `${sentences.join(' ')} agy ends the turn when a tool is refused.`;
}

/** Reply recorded for a turn agy ended after a refusal, when the model wrote nothing (pure). */
export function blockedToolsReply(blocked: readonly BlockedTool[] | undefined): string | undefined {
	const text = describeBlockedTools(blocked ?? []);
	return text ? `Stopped: ${text}` : undefined;
}

/** The prompt the "Continue" button sends after a refusal (pure). */
export function blockedContinuePrompt(blocked: readonly BlockedTool[]): string {
	const names = formatToolNames([...new Set(blocked.map((b) => b.name))]);
	const parts = [`Continue the previous request without ${names}.`];
	if (blocked.some((b) => b.reason === 'vault' || b.reason === 'write')) {
		parts.push('Use the antidian-vault tools to read and edit vault notes.');
	}
	if (blocked.some((b) => b.reason === 'shell')) {
		parts.push('Shell commands are not available.');
	}
	return parts.join(' ');
}
