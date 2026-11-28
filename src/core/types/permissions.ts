/**
 * Contracts for `agy`'s `session/request_permission` requests: the built-in and
 * MCP tool calls Antidian neither allows nor refuses on its own are put to the user.
 */

/** The user's answer to a tool permission request. */
export type ToolPermissionDecision = 'allow_once' | 'allow_session' | 'deny' | 'cancel';

export interface ToolPermissionRequest {
	/** Tool name as shown in the trace (vault MCP prefix removed). */
	toolName: string;
	/** What the call reaches, for display: a path, a URL, or `server/tool`. */
	target?: string;
	/** What "Allow for this session" covers, e.g. "read_file in /home/me/Downloads". */
	sessionScope: string;
	/** True when the turn runs in read-only Plan mode. */
	planMode: boolean;
	/** The tool arguments as `agy` reported them (untrusted). */
	rawInput?: Record<string, unknown>;
}

export type ToolPermissionHandler = (
	request: ToolPermissionRequest,
) => Promise<ToolPermissionDecision>;

/**
 * Why a tool call was refused:
 * - `vault`: a built-in file tool reached into the vault (vault access goes through `antidian-vault`).
 * - `write`: a built-in tool that writes files (writes are staged by `antidian-vault`).
 * - `shell`: a shell command.
 * - `user`: the user denied it.
 * - `unanswered`: it needed the user's permission, but nothing could ask.
 */
export type BlockedToolReason = 'vault' | 'write' | 'shell' | 'user' | 'unanswered';

export interface BlockedTool {
	name: string;
	reason: BlockedToolReason;
}
