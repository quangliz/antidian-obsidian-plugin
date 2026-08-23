import {
	ChangeSet,
	ChangeSetDiff,
	DiffHunk,
	DiffLine,
	FileDiff,
} from '../types/changes';
import { VaultService } from '../types/vault';

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

		for (const op of changeSet.operations) {
			let oldContent = '';
			let headingHeader: string | undefined;

			if (op.type === 'create') {
				oldContent = '';
				headingHeader = undefined;
			} else if (op.type === 'patch-section') {
				const existing = await this.vaultService.readNote({
					path: op.path,
					heading: op.heading,
				});
				oldContent = existing?.content ?? '';
				headingHeader = `## ${op.heading}`;
			}

			const lines = computeLineDiff(oldContent, op.content);

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
				heading: op.type === 'patch-section' ? op.heading : undefined,
				oldContent,
				newContent: op.content,
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
