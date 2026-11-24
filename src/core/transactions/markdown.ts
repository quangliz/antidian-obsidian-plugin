import type { NoteHeading } from '../types/vault';

export interface HeadingSpan extends NoteHeading {
	startOffset: number;
	endOffset: number;
}

export type BlockReplaceResult =
	| { ok: true; content: string }
	| { ok: false; reason: 'empty_target' | 'not_found' | 'ambiguous'; matchCount: number };

export function normalizeHeadingText(heading: string): string {
	return heading.trim().toLowerCase().replace(/^#+\s*/, '');
}

/**
 * Extracts ATX markdown headings while ignoring YAML frontmatter and fenced code blocks.
 */
export function extractMarkdownHeadings(content: string): HeadingSpan[] {
	const headings: HeadingSpan[] = [];
	const lines = content.split('\n');
	let offset = 0;
	let inFence: string | null = null;
	let inFrontmatter = false;

	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i] ?? '';
		const lineLen = rawLine.length;
		const trimmed = rawLine.trim();

		if (i === 0 && trimmed === '---') {
			inFrontmatter = true;
			offset += lineLen + 1;
			continue;
		}
		if (inFrontmatter) {
			if (trimmed === '---' || trimmed === '...') {
				inFrontmatter = false;
			}
			offset += lineLen + 1;
			continue;
		}

		const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
		if (fenceMatch && fenceMatch[1]) {
			const marker = fenceMatch[1].charAt(0);
			if (!inFence) {
				inFence = marker;
			} else if (inFence === marker) {
				inFence = null;
			}
			offset += lineLen + 1;
			continue;
		}

		if (!inFence) {
			const hMatch = rawLine.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
			if (hMatch && hMatch[1] && hMatch[2]) {
				headings.push({
					level: hMatch[1].length,
					heading: hMatch[2].trim(),
					line: i,
					startOffset: offset,
					endOffset: content.length,
				});
			}
		}

		offset += lineLen + 1;
	}

	for (let i = 0; i < headings.length; i++) {
		const cur = headings[i]!;
		for (let j = i + 1; j < headings.length; j++) {
			const next = headings[j]!;
			if (next.level <= cur.level) {
				cur.endOffset = next.startOffset;
				break;
			}
		}
	}

	return headings;
}

export function findHeadingSpan(
	content: string,
	heading: string,
): HeadingSpan | null {
	const target = normalizeHeadingText(heading);
	if (!target) return null;
	const spans = extractMarkdownHeadings(content);
	return (
		spans.find((h) => normalizeHeadingText(h.heading) === target) ?? null
	);
}

export function extractSection(content: string, heading: string): string | null {
	const span = findHeadingSpan(content, heading);
	if (!span) return null;
	return content.slice(span.startOffset, span.endOffset).trim();
}

export function applySectionPatch(
	fullContent: string,
	heading: string,
	newContent: string,
): string {
	const span = findHeadingSpan(fullContent, heading);
	if (span) {
		let replacement = newContent;
		if (!newContent.trim().startsWith('#')) {
			const hashes = '#'.repeat(span.level);
			replacement = `${hashes} ${span.heading}\n\n${newContent.trim()}\n\n`;
		} else {
			replacement = `${newContent.trim()}\n\n`;
		}

		const tail = fullContent.slice(span.endOffset).trimStart();
		if (!tail) {
			return `${fullContent.slice(0, span.startOffset)}${replacement.trimEnd()}\n`;
		}
		return `${fullContent.slice(0, span.startOffset)}${replacement}${tail}`;
	}

	const prefix = fullContent.endsWith('\n') ? fullContent : `${fullContent}\n`;
	return `${prefix}\n## ${heading}\n\n${newContent.trim()}\n`;
}

export function applyBlockReplace(
	content: string,
	oldText: string,
	newText: string,
): BlockReplaceResult {
	if (!oldText) {
		return { ok: false, reason: 'empty_target', matchCount: 0 };
	}

	let matchCount = 0;
	let searchFrom = 0;
	let firstIndex = -1;

	while (true) {
		const idx = content.indexOf(oldText, searchFrom);
		if (idx === -1) break;
		if (firstIndex === -1) firstIndex = idx;
		matchCount++;
		searchFrom = idx + oldText.length;
		if (matchCount > 1) break;
	}

	if (matchCount === 0) {
		return { ok: false, reason: 'not_found', matchCount: 0 };
	}
	if (matchCount > 1) {
		return { ok: false, reason: 'ambiguous', matchCount };
	}

	const updated =
		content.slice(0, firstIndex) +
		newText +
		content.slice(firstIndex + oldText.length);
	return { ok: true, content: updated };
}

export function applyAppend(
	fullContent: string,
	addition: string,
	heading?: string,
): { ok: true; content: string } | { ok: false; reason: 'heading_not_found' } {
	const cleanAddition = addition.trim();
	if (!heading) {
		if (!fullContent) {
			return { ok: true, content: `${cleanAddition}\n` };
		}
		const sep = fullContent.endsWith('\n\n')
			? ''
			: fullContent.endsWith('\n')
				? '\n'
				: '\n\n';
		return { ok: true, content: `${fullContent}${sep}${cleanAddition}\n` };
	}

	const span = findHeadingSpan(fullContent, heading);
	if (!span) {
		return { ok: false, reason: 'heading_not_found' };
	}

	const beforeEnd = fullContent.slice(0, span.endOffset).trimEnd();
	const afterEnd = fullContent.slice(span.endOffset).trimStart();
	if (!afterEnd) {
		return { ok: true, content: `${beforeEnd}\n\n${cleanAddition}\n` };
	}
	return {
		ok: true,
		content: `${beforeEnd}\n\n${cleanAddition}\n\n${afterEnd}`,
	};
}

function formatYamlScalar(value: unknown): string {
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'boolean' || typeof value === 'number') {
		return String(value);
	}
	const str = typeof value === 'string' ? value : JSON.stringify(value);
	if (
		str === '' ||
		/[:#[\]{}&*!|>'"%@`]/.test(str) ||
		/^\s|\s$/.test(str) ||
		/^(true|false|null|~|\d+(\.\d+)?)$/i.test(str)
	) {
		return JSON.stringify(str);
	}
	return str;
}

function formatYamlEntry(key: string, value: unknown): string[] {
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return [`${key}: []`];
		}
		const lines = [`${key}:`];
		for (const item of value) {
			lines.push(`  - ${formatYamlScalar(item)}`);
		}
		return lines;
	}
	return [`${key}: ${formatYamlScalar(value)}`];
}

interface ParsedFrontmatterBlock {
	hasFrontmatter: boolean;
	entries: { key: string; rawLines: string[] }[];
	body: string;
}

function parseFrontmatterBlock(content: string): ParsedFrontmatterBlock {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!match) {
		// Handle empty frontmatter `---\n---`
		const emptyMatch = content.match(/^---\r?\n---(?:\r?\n|$)/);
		if (emptyMatch) {
			return {
				hasFrontmatter: true,
				entries: [],
				body: content.slice(emptyMatch[0].length),
			};
		}
		return { hasFrontmatter: false, entries: [], body: content };
	}

	const yamlBody = match[1] ?? '';
	const body = content.slice(match[0].length);
	const rawLines = yamlBody.split(/\r?\n/);
	const entries: { key: string; rawLines: string[] }[] = [];

	for (const line of rawLines) {
		const keyMatch = line.match(/^([A-Za-z0-9_-]+)\s*:/);
		if (keyMatch && keyMatch[1]) {
			entries.push({ key: keyMatch[1], rawLines: [line] });
		} else if (entries.length > 0) {
			entries[entries.length - 1]!.rawLines.push(line);
		}
	}

	return { hasFrontmatter: true, entries, body };
}

export function parseSimpleFrontmatter(
	content: string,
): Record<string, unknown> | undefined {
	const parsed = parseFrontmatterBlock(content);
	if (!parsed.hasFrontmatter) return undefined;

	const out: Record<string, unknown> = {};
	for (const entry of parsed.entries) {
		const firstLine = entry.rawLines[0] ?? '';
		const colonIdx = firstLine.indexOf(':');
		const inlineVal = firstLine.slice(colonIdx + 1).trim();

		if (entry.rawLines.length > 1 && !inlineVal) {
			const items: string[] = [];
			for (let i = 1; i < entry.rawLines.length; i++) {
				const sub = (entry.rawLines[i] ?? '').trim();
				if (sub.startsWith('- ')) {
					items.push(sub.slice(2).trim().replace(/^["']|["']$/g, ''));
				}
			}
			out[entry.key] = items;
		} else if (inlineVal.startsWith('[') && inlineVal.endsWith(']')) {
			const inner = inlineVal.slice(1, -1).trim();
			out[entry.key] = inner
				? inner
						.split(',')
						.map((s) => s.trim().replace(/^["']|["']$/g, ''))
						.filter(Boolean)
				: [];
		} else if (inlineVal === 'true') {
			out[entry.key] = true;
		} else if (inlineVal === 'false') {
			out[entry.key] = false;
		} else if (inlineVal === 'null' || inlineVal === '~') {
			out[entry.key] = null;
		} else if (inlineVal !== '' && !Number.isNaN(Number(inlineVal))) {
			out[entry.key] = Number(inlineVal);
		} else {
			out[entry.key] = inlineVal.replace(/^["']|["']$/g, '');
		}
	}

	return out;
}

export function applyFrontmatterUpdate(
	content: string,
	set?: Record<string, unknown>,
	remove?: string[],
): string {
	const parsed = parseFrontmatterBlock(content);
	const removeSet = new Set((remove ?? []).map((k) => k.trim()).filter(Boolean));
	const setEntries = Object.entries(set ?? {});

	const nextEntries: { key: string; rawLines: string[] }[] = [];
	const handledKeys = new Set<string>();

	for (const entry of parsed.entries) {
		if (removeSet.has(entry.key)) {
			continue;
		}
		const override = setEntries.find(([k]) => k === entry.key);
		if (override) {
			nextEntries.push({
				key: entry.key,
				rawLines: formatYamlEntry(entry.key, override[1]),
			});
			handledKeys.add(entry.key);
		} else {
			nextEntries.push(entry);
		}
	}

	for (const [k, v] of setEntries) {
		if (handledKeys.has(k) || removeSet.has(k)) continue;
		nextEntries.push({
			key: k,
			rawLines: formatYamlEntry(k, v),
		});
	}

	if (nextEntries.length === 0) {
		return parsed.body.replace(/^\r?\n/, '');
	}

	const yamlLines = nextEntries.flatMap((e) => e.rawLines).join('\n');
	const body = parsed.body.replace(/^\r?\n/, '');
	return body
		? `---\n${yamlLines}\n---\n\n${body}`
		: `---\n${yamlLines}\n---\n`;
}
