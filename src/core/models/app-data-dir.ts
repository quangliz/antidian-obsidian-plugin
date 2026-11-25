import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LEGACY_PLUGIN_ID } from '../legacy-names';

/** Dedicated agy data dir that keeps Antidian sessions out of the CLI history. */
export const APP_DATA_DIR = 'antigravity-antidian';
export const LEGACY_APP_DATA_DIR = `antigravity-${LEGACY_PLUGIN_ID}`;

/**
 * Keeps using the data dir of the former plugin id where it exists. It is not
 * moved: agy stores absolute paths in it, and another vault may have it open.
 */
export function resolveAppDataDir(homeDir: string = os.homedir()): string {
	const exists = (dir: string): boolean => fs.existsSync(path.join(homeDir, '.gemini', dir));
	return !exists(APP_DATA_DIR) && exists(LEGACY_APP_DATA_DIR)
		? LEGACY_APP_DATA_DIR
		: APP_DATA_DIR;
}
