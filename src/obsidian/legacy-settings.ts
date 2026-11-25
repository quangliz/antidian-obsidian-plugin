import type { App } from 'obsidian';
import { LEGACY_PLUGIN_ID } from '../core/legacy-names';

/** Settings saved under the former plugin id, or null when there are none. */
export async function loadLegacySettings(app: App): Promise<Record<string, unknown> | null> {
	const path = `${app.vault.configDir}/plugins/${LEGACY_PLUGIN_ID}/data.json`;
	try {
		if (!(await app.vault.adapter.exists(path))) return null;
		const data: unknown = JSON.parse(await app.vault.adapter.read(path));
		return typeof data === 'object' && data !== null && !Array.isArray(data)
			? (data as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}
