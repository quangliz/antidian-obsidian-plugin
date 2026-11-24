import type {
	ChangeSet,
	ChangeSetDiff,
	DiffHunk,
	DiffLine,
	FileDiff,
} from '../types/changes';
import type { VaultService } from '../types/vault';
import { applyOperationToContent } from './overlay';
import { extractSection } from './markdown';

export const DEFAULT_DIFF_CONTEXT_LINES = 3;

export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
	const oldLines = oldText ? oldText.split('\n') : [];
	const newLines = newText ? newText.split('\n') : [];

	const n = oldLines.length;
	const m = newLines.length;

	// Trim identical prefix and suffix so localized edits on long notes stay fast.
	let prefix = 0;
	while (prefix < n && prefix < m && oldLines[prefix] === newLines[prefix]) {
		prefix++;
	}

	let suffix = 0;
	while (
		suffix < n - prefix &&
		suffix < m - prefix &&
		oldLines[n - 1 - suffix] === newLines[m - 1 - suffix]
	) {
		suffix++;
	}

	const result: DiffLine[] = [];
	for (let k = 0; k < prefix; k++) {
		result.push({
			type: 'context',
			content: oldLines[k] ?? '',
			oldLineNumber: k + 1,
			newLineNumber: k + 1,
		});
	}

	const midOldLen = n - prefix - suffix;
	const midNewLen = m - prefix - suffix;

	if (midOldLen > 0 || midNewLen > 0) {
		const dp: number[][] = Array.from({ length: midOldLen + 1 }, () =>
			new Array<number>(midNewLen + 1).fill(0),
		);

		for (let i = 0; i < midOldLen; i++) {
			for (let j = 0; j < midNewLen; j++) {
				if (oldLines[prefix + i] === newLines[prefix + j]) {
					dp[i + 1]![j + 1] = (dp[i]![j] ?? 0) + 1;
				} else {
					dp[i + 1]![j + 1] = Math.max(
						dp[i]![j + 1] ?? 0,
						dp[i + 1]![j] ?? 0,
					);
				}
			}
		}

		const midResult: DiffLine[] = [];
		let i = midOldLen;
		let j = midNewLen;

		while (i > 0 || j > 0) {
			if (
				i > 0 &&
				j > 0 &&
				oldLines[prefix + i - 1] === newLines[prefix + j - 1]
			) {
				midResult.push({
					type: 'context',
					content: oldLines[prefix + i - 1] ?? '',
					oldLineNumber: prefix + i,
					newLineNumber: prefix + j,
				});
				i--;
				j--;
			} else if (
				j > 0 &&
				(i === 0 || (dp[i]![j - 1] ?? 0) >= (dp[i - 1]![j] ?? 0))
			) {
				midResult.push({
					type: 'added',
					content: newLines[prefix + j - 1] ?? '',
					newLineNumber: prefix + j,
				});
				j--;
			} else if (
				i > 0 &&
				(j === 0 || (dp[i]![j - 1] ?? 0) < (dp[i - 1]![j] ?? 0))
			) {
				midResult.push({
					type: 'removed',
					content: oldLines[prefix + i - 1] ?? '',
					oldLineNumber: prefix + i,
				});
				i--;
			}
		}

		midResult.reverse();
		result.push(...midResult);
	}

	for (let k = 0; k < suffix; k++) {
		const oldIdx = n - suffix + k;
		const newIdx = m - suffix + k;
		result.push({
			type: 'context',
			content: oldLines[oldIdx] ?? '',
			oldLineNumber: oldIdx + 1,
			newLineNumber: newIdx + 1,
		});
	}

	return result;
}

export interface GroupHunksOptions {
	contextLines?: number;
	label?: string;
	showLineNumbers?: boolean;
}

/**
 * Collapses a full line diff into GitHub-style unified hunks containing only
 * changed lines plus `contextLines` surrounding unchanged lines.
 */
export function groupDiffHunks(
	lines: DiffLine[],
	options: GroupHunksOptions = {},
): DiffHunk[] {
	const contextLines = options.contextLines ?? DEFAULT_DIFF_CONTEXT_LINES;
	const { label, showLineNumbers = true } = options;

	const ranges: Array<{ start: number; end: number }> = [];
	for (let idx = 0; idx < lines.length; idx++) {
		if (lines[idx]?.type === 'context') continue;
		const start = Math.max(0, idx - contextLines);
		const end = Math.min(lines.length - 1, idx + contextLines);
		const prev = ranges[ranges.length - 1];
		if (prev && start <= prev.end + 1) {
			prev.end = Math.max(prev.end, end);
		} else {
			ranges.push({ start, end });
		}
	}

	if (ranges.length === 0) {
		return [];
	}

	return ranges.map((range, hunkIndex) => {
		const hunkLines = lines.slice(range.start, range.end + 1);
		let header: string | undefined;

		if (showLineNumbers) {
			let oldStart = 0;
			let oldCount = 0;
			let newStart = 0;
			let newCount = 0;

			for (const line of hunkLines) {
				if (line.type !== 'added') {
					if (oldStart === 0 && line.oldLineNumber !== undefined) {
						oldStart = line.oldLineNumber;
					}
					oldCount++;
				}
				if (line.type !== 'removed') {
					if (newStart === 0 && line.newLineNumber !== undefined) {
						newStart = line.newLineNumber;
					}
					newCount++;
				}
			}

			const rangeHeader = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
			header =
				hunkIndex === 0 && label
					? `${label}  ${rangeHeader}`
					: rangeHeader;
		} else {
			header = hunkIndex === 0 ? label : '...';
		}

		return {
			header,
			lines: hunkLines,
		};
	});
}

export class ChangeSetDiffGenerator {
	private vaultService: VaultService;

	constructor(vaultService: VaultService) {
		this.vaultService = vaultService;
	}

	async generate(changeSet: ChangeSet): Promise<ChangeSetDiff> {
		const files: FileDiff[] = [];
		let totalAdditions = 0;
		let totalDeletions = 0;
		const runningContents = new Map<string, string | null>();

		const getCurrentContent = async (
			path: string,
		): Promise<string | null> => {
			const norm = this.vaultService.normalizePath(path);
			if (runningContents.has(norm)) {
				return runningContents.get(norm) ?? null;
			}
			const existing = await this.vaultService.readNote({ path });
			const content = existing?.content ?? null;
			runningContents.set(norm, content);
			return content;
		};

		for (const op of changeSet.operations) {
			const norm = this.vaultService.normalizePath(op.path);
			const beforeFull = await getCurrentContent(op.path);
			const applied = applyOperationToContent(beforeFull, op);
			const afterFull = applied.ok
				? applied.content
				: (beforeFull ?? '');

			if (applied.ok) {
				runningContents.set(norm, afterFull);
			}

			let oldDiffText = beforeFull ?? '';
			let newDiffText = afterFull;
			let headingHeader: string | undefined;
			let headingValue: string | undefined;

			if (op.type === 'patch-section') {
				oldDiffText = beforeFull
					? (extractSection(beforeFull, op.heading) ?? beforeFull)
					: '';
				newDiffText =
					extractSection(afterFull, op.heading) ?? op.content;
				headingHeader = `## ${op.heading}`;
				headingValue = op.heading;
			} else if (op.type === 'replace-block') {
				oldDiffText = op.oldText;
				newDiffText = op.newText;
				headingHeader = 'Replace block';
			} else if (op.type === 'append') {
				headingHeader = op.heading
					? `Append under ## ${op.heading}`
					: 'Append to end';
				headingValue = op.heading;
			} else if (op.type === 'update-frontmatter') {
				headingHeader = 'Frontmatter';
			}

			const lines = computeLineDiff(oldDiffText, newDiffText);

			let additions = 0;
			let deletions = 0;
			for (const line of lines) {
				if (line.type === 'added') additions++;
				if (line.type === 'removed') deletions++;
			}

			totalAdditions += additions;
			totalDeletions += deletions;

			const isFullFileDiff =
				op.type === 'create' ||
				op.type === 'edit' ||
				op.type === 'append' ||
				op.type === 'update-frontmatter';

			const hunks = groupDiffHunks(lines, {
				contextLines: DEFAULT_DIFF_CONTEXT_LINES,
				label: headingHeader,
				showLineNumbers: isFullFileDiff,
			});

			files.push({
				path: op.path,
				operationType: op.type,
				heading: headingValue,
				oldContent: oldDiffText,
				newContent: newDiffText,
				hunks,
				additions,
				deletions,
			});
		}

		return {
			changeSetId: changeSet.id,
			files,
			totalAdditions,
			totalDeletions,
		};
	}
}
