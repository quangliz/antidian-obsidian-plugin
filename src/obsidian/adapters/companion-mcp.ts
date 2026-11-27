import type { App } from 'obsidian';
import { MCP_SERVER_NAME } from '../../core/legacy-names';
import {
	COMPANION_MCP_PLUGIN_SUFFIX,
	normalizeCompanionMcpServer,
	type CompanionMcpServer,
} from '../../core/types';

interface CompanionPluginInstance {
	manifest?: {
		id?: string;
		name?: string;
	};
	getAntidianMcpServer?: () => unknown;
}

interface ObsidianPluginManagerLike {
	enabledPlugins?: Set<string>;
	plugins?: Record<string, CompanionPluginInstance | undefined>;
}

/**
 * Discovers enabled Obsidian plugins whose ID ends with `-antidian` and expose
 * `getAntidianMcpServer()`, returning validated loopback HTTP MCP descriptors.
 */
export function discoverCompanionMcpServers(app: App): CompanionMcpServer[] {
	const manager = (app as App & { plugins?: ObsidianPluginManagerLike }).plugins;
	const instances = manager?.plugins;
	if (!instances || typeof instances !== 'object') {
		return [];
	}

	const enabled = manager?.enabledPlugins;
	const reservedNames = new Set<string>([MCP_SERVER_NAME]);
	const discovered: CompanionMcpServer[] = [];

	for (const [pluginId, instance] of Object.entries(instances)) {
		if (!pluginId.endsWith(COMPANION_MCP_PLUGIN_SUFFIX)) continue;
		if (enabled instanceof Set && !enabled.has(pluginId)) continue;
		if (!instance || typeof instance.getAntidianMcpServer !== 'function') continue;

		try {
			const raw = instance.getAntidianMcpServer();
			if (!raw) continue;
			const pluginName = instance.manifest?.name ?? pluginId;
			const normalized = normalizeCompanionMcpServer(
				pluginId,
				pluginName,
				raw,
				reservedNames,
			);
			if (!normalized) continue;
			reservedNames.add(normalized.serverName);
			discovered.push(normalized);
		} catch {
			// Skip companion plugins whose MCP endpoint is unavailable or throws.
		}
	}

	return discovered.sort((a, b) => a.pluginName.localeCompare(b.pluginName));
}
