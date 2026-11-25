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
