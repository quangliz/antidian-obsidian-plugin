export const COMPANION_MCP_PLUGIN_SUFFIX = '-antidian';

const SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

export interface CompanionMcpHeader {
	name: string;
	value: string;
}

/** Shape returned by `plugin.getAntidianMcpServer()` on companion `*-antidian` plugins. */
export interface CompanionMcpDescriptor {
	name: string;
	url: string;
	headers?: CompanionMcpHeader[];
	description?: string;
	version?: string;
}

export interface CompanionMcpServer {
	pluginId: string;
	pluginName: string;
	serverName: string;
	url: string;
	headers?: CompanionMcpHeader[];
	description?: string;
	version?: string;
}

export type CompanionMcpResolver = () => CompanionMcpServer[];

/**
 * Validates and normalizes a companion plugin's MCP descriptor.
 * Enforces `-antidian` ID suffix, valid server name, and loopback HTTP-only URLs.
 */
export function normalizeCompanionMcpServer(
	pluginId: string,
	pluginName: string,
	raw: unknown,
	reservedServerNames: ReadonlySet<string> = new Set(),
): CompanionMcpServer | null {
	if (!pluginId.endsWith(COMPANION_MCP_PLUGIN_SUFFIX)) return null;
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

	const record = raw as Record<string, unknown>;
	const rawName = typeof record.name === 'string' ? record.name.trim() : '';
	if (!SERVER_NAME_PATTERN.test(rawName)) return null;
	if (reservedServerNames.has(rawName)) return null;

	const rawUrl = typeof record.url === 'string' ? record.url.trim() : '';
	if (!rawUrl) return null;

	let parsedUrl: URL;
	try {
		parsedUrl = new URL(rawUrl);
	} catch {
		return null;
	}
	if (parsedUrl.protocol !== 'http:') return null;
	if (!LOOPBACK_HOSTS.has(parsedUrl.hostname)) return null;

	let headers: CompanionMcpHeader[] | undefined;
	if (record.headers !== undefined) {
		if (!Array.isArray(record.headers)) return null;
		const validHeaders: CompanionMcpHeader[] = [];
		for (const item of record.headers) {
			if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
			const entry = item as Record<string, unknown>;
			if (typeof entry.name !== 'string' || typeof entry.value !== 'string') {
				return null;
			}
			const hName = entry.name.trim();
			if (!hName) return null;
			validHeaders.push({ name: hName, value: entry.value });
		}
		if (validHeaders.length > 0) headers = validHeaders;
	}

	const description =
		typeof record.description === 'string' && record.description.trim()
			? record.description.trim()
			: undefined;
	const version =
		typeof record.version === 'string' && record.version.trim()
			? record.version.trim()
			: undefined;

	return {
		pluginId,
		pluginName: pluginName.trim() || pluginId,
		serverName: rawName,
		url: parsedUrl.toString(),
		...(headers ? { headers } : {}),
		...(description ? { description } : {}),
		...(version ? { version } : {}),
	};
}

/** Converts a validated companion MCP server into the ACP `session/new` HTTP server entry. */
export function toAcpHttpMcpServer(server: CompanionMcpServer): Record<string, unknown> {
	return {
		type: 'http',
		name: server.serverName,
		url: server.url,
		...(server.headers && server.headers.length > 0 ? { headers: server.headers } : {}),
	};
}
