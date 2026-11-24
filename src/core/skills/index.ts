import type { SkillDocument } from '../types/skills';
import { parseSimpleFrontmatter } from '../transactions/markdown';

export const DEFAULT_SKILLS_FOLDER = '.anti-dian/skills';

/**
 * Parses a markdown skill file with optional YAML frontmatter (`name`, `description`).
 * Pure function with no Obsidian dependency.
 */
export function parseSkillMarkdown(
	rawContent: string,
	filePath: string,
	fallbackName: string,
): SkillDocument {
	const fm = parseSimpleFrontmatter(rawContent);
	const bodyMatch = rawContent.match(
		/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
	);
	const body = (bodyMatch ? rawContent.slice(bodyMatch[0].length) : rawContent).trim();

	const name =
		typeof fm?.name === 'string' && fm.name.trim()
			? fm.name.trim()
			: fallbackName;

	let description =
		typeof fm?.description === 'string' && fm.description.trim()
			? fm.description.trim()
			: '';

	if (!description) {
		const firstLine = body
			.split(/\r?\n/)
			.map((l) => l.trim())
			.find((l) => l.length > 0 && !l.startsWith('#'));
		description = firstLine ? firstLine.slice(0, 140) : 'Custom vault workflow skill';
	}

	return {
		name,
		description,
		path: filePath,
		body,
	};
}
