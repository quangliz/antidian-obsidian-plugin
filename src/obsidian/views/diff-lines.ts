import { FileDiff } from '../../core/types/changes';

/** Render one operation's diff hunks as +/- lines (shared by trace and review UI). */
export function renderFileDiff(container: HTMLElement, file: FileDiff): void {
	const box = container.createDiv({ cls: 'anti-dian-diff-inline-box' });

	if (file.hunks.length === 0) {
		box.createDiv({ cls: 'anti-dian-diff-line diff-context', text: 'No textual change' });
		return;
	}

	for (const hunk of file.hunks) {
		if (hunk.header) {
			box.createDiv({
				text: hunk.header,
				cls: 'anti-dian-diff-line diff-hunk-header',
			});
		}
		for (const line of hunk.lines) {
			const prefix =
				line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
			box.createDiv({
				cls: `anti-dian-diff-line diff-${line.type}`,
				text: `${prefix} ${line.content}`,
			});
		}
	}
}
