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

export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
	const oldLines = oldText ? oldText.split('\n') : [];
	const newLines = newText ? newText.split('\n') : [];

	const n = oldLines.length;
	const m = newLines.length;

	const dp: number[][] = Array.from({ length: n + 1 }, () =>
		new Array<number>(m + 1).fill(0),
	);

	for (let i = 0; i < n; i++) {
		for (let j = 0; j < m; j++) {
			if (oldLines[i] === newLines[j]) {
				dp[i + 1]![j + 1] = (dp[i]![j] ?? 0) + 1;
			} else {
				dp[i + 1]![j + 1] = Math.max(
					dp[i]![j + 1] ?? 0,
					dp[i + 1]![j] ?? 0,
				);
			}
		}
	}

	const result: DiffLine[] = [];
	let i = n;
	let j = m;

	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
			result.unshift({
				type: 'context',
				content: oldLines[i - 1] ?? '',
				oldLineNumber: i,
				newLineNumber: j,
			});
			i--;
			j--;
		} else if (
			j > 0 &&
			(i === 0 || (dp[i]![j - 1] ?? 0) >= (dp[i - 1]![j] ?? 0))
		) {
			result.unshift({
				type: 'added',
				content: newLines[j - 1] ?? '',
				newLineNumber: j,
			});
			j--;
		} else if (
			i > 0 &&
			(j === 0 || (dp[i]![j - 1] ?? 0) < (dp[i - 1]![j] ?? 0))
		) {
			result.unshift({
				type: 'removed',
				content: oldLines[i - 1] ?? '',
				oldLineNumber: i,
			});
			i--;
		}
	}

	return result;
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

			const hunks: DiffHunk[] = [
				{
					header: headingHeader,
					lines,
				},
			];

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
