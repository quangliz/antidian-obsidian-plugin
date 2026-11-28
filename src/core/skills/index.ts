import { isPathInside, toAbsolutePath } from '../models/tool-permissions';

/**
 * Name of the skill a tool call loads, if any: `agy` reads a skill's `SKILL.md`
 * with `read_file`; sessions from before that used a `load_skill` tool.
 */
export function loadedSkillName(
	toolName: string,
	args: Record<string, unknown> | undefined,
): string | undefined {
	if (toolName === 'load_skill') {
		return typeof args?.name === 'string' ? args.name : undefined;
	}
	if (toolName !== 'read_file' || typeof args?.Path !== 'string') return undefined;
	return /([^\\/]+)[\\/]SKILL\.md$/.exec(args.Path)?.[1];
}

/**
 * Whether `filePath` is a file inside a skill folder (`<root>/<skill>/...`) under
 * one of `skillRoots`: a skill's `SKILL.md` and the files it references. Accepts
 * `file://` URIs; paths with `.`/`..` segments or that are not absolute never match.
 */
export function isSkillFilePath(filePath: unknown, skillRoots: readonly string[]): boolean {
	const file = toAbsolutePath(filePath);
	return file !== null && skillRoots.some((root) => isPathInside(file, root, 2));
}
