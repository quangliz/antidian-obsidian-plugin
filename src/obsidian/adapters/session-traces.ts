import { App, normalizePath } from 'obsidian';
import type {
	SessionTraceStore,
	StoredTurnTrace,
} from '../../core/types/sessions';
import { parseStoredTurns } from '../../core/sessions/trace';

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Saves per-turn traces as `<pluginDir>/sessions/<sessionId>.json` through the
 * vault adapter (the plugin folder is config, not notes, so it is not indexed).
 */
export class ObsidianSessionTraceStore implements SessionTraceStore {
	private folder: string;
	/** Serializes writes per session so appends never interleave. */
	private writes = new Map<string, Promise<void>>();

	constructor(
		private app: App,
		pluginDir: string,
	) {
		this.folder = normalizePath(`${pluginDir}/sessions`);
	}

	async loadTurns(sessionId: string): Promise<StoredTurnTrace[]> {
		const file = this.fileFor(sessionId);
		if (!file) return [];
		await this.writes.get(sessionId);
		const adapter = this.app.vault.adapter;
		try {
			if (!(await adapter.exists(file))) return [];
			return parseStoredTurns(JSON.parse(await adapter.read(file)));
		} catch {
			return [];
		}
	}

	appendTurn(sessionId: string, turn: StoredTurnTrace): Promise<void> {
		const file = this.fileFor(sessionId);
		if (!file) return Promise.resolve();
		const previous = this.writes.get(sessionId) ?? Promise.resolve();
		const write = previous
			.catch(() => undefined)
			.then(async () => {
				const adapter = this.app.vault.adapter;
				let turns: StoredTurnTrace[] = [];
				if (await adapter.exists(file)) {
					try {
						turns = parseStoredTurns(JSON.parse(await adapter.read(file)));
					} catch {
						turns = [];
					}
				} else if (!(await adapter.exists(this.folder))) {
					await adapter.mkdir(this.folder);
				}
				turns.push(turn);
				await adapter.write(
					file,
					JSON.stringify({ version: 1, sessionId, turns }),
				);
			});
		this.writes.set(sessionId, write);
		void write.finally(() => {
			if (this.writes.get(sessionId) === write) this.writes.delete(sessionId);
		});
		return write;
	}

	private fileFor(sessionId: string): string | null {
		return SESSION_ID_PATTERN.test(sessionId)
			? normalizePath(`${this.folder}/${sessionId}.json`)
			: null;
	}
}
