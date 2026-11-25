/**
 * The plugin's id was `anti-dian` up to 1.0.1. Names that reached stored data
 * (sessions, transcripts, settings) are still recognized so nothing is lost.
 */
export const LEGACY_PLUGIN_ID = 'anti-dian';

/** Name of the vault MCP server given to `agy`. */
export const MCP_SERVER_NAME = 'antidian-vault';

/** How `agy` prefixes the tools of that server. */
export const MCP_TOOL_PREFIX = `mcp_${MCP_SERVER_NAME}_`;

const MCP_TOOL_PREFIXES = [MCP_TOOL_PREFIX, `mcp_${LEGACY_PLUGIN_ID}-vault_`];

/** Vault tool name without its MCP prefix; other names are returned as is. */
export function stripMcpPrefix(name: string): string {
	const prefix = MCP_TOOL_PREFIXES.find((p) => name.startsWith(p));
	return prefix ? name.slice(prefix.length) : name;
}
