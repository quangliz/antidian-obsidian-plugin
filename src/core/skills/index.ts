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
 * one of `skillRoots`. The model may read these with agy's built-in `read_file`:
 * a skill's `SKILL.md` and the files it references. Pure string check; paths
 * with `..` segments or that are not absolute never match.
 */
export function isSkillFilePath(filePath: unknown, skillRoots: readonly string[]): boolean {
	if (typeof filePath !== 'string' || filePath.includes('\0')) return false;
	const file = filePath.replace(/\\/g, '/');
	const isAbsolute = file.startsWith('/') || /^[A-Za-z]:\//.test(file);
	if (!isAbsolute || file.split('/').includes('..')) return false;
	return skillRoots.some((root) => {
		const prefix = `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/`;
		if (!file.startsWith(prefix)) return false;
		// At least `<skill>/<file>` below the root, never the root's own files.
		const rest = file.slice(prefix.length).split('/');
		return rest.length >= 2 && rest.every((segment) => segment.length > 0);
	});
}
