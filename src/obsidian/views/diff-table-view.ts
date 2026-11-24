import { App, ButtonComponent, Modal, Setting, setIcon } from 'obsidian';
import { bindNoteLink } from './note-link';
import { ChangeSet, ChangeSetDiff, FileDiff } from '../../core/types/changes';
import type AntiDianPlugin from '../../main';

export class DiffTableView {
	private plugin: AntiDianPlugin;
	private changeSet: ChangeSet;
	private diff: ChangeSetDiff;
	private containerEl: HTMLElement;
	private isExpanded = true;
	private isAccepted = false;
	private isRejected = false;
	private expandedFileIndex: number | null = null;

	constructor(
		parentEl: HTMLElement,
		changeSet: ChangeSet,
		diff: ChangeSetDiff,
		plugin: AntiDianPlugin,
	) {
		this.containerEl = parentEl.createDiv({
			cls: 'anti-dian-diff-summary-card',
		});
		this.changeSet = changeSet;
		this.diff = diff;
		this.plugin = plugin;

		void this.handleAutoMode();
		this.render();
	}

	private async handleAutoMode(): Promise<void> {
		const mode = this.plugin.settings.permissionMode ?? 'ask';
		if (mode === 'auto') {
			try {
				await this.plugin.applicator.apply(this.changeSet);
				this.isAccepted = true;
				this.render();
			} catch {
				this.render();
			}
		}
	}

	private render(): void {
		this.containerEl.empty();

		// Header Row: "4 files changed +195 -87 ˅" and "[📄 Review]"
		const headerRow = this.containerEl.createDiv({
			cls: 'anti-dian-diff-card-header',
		});

		const leftSummaryBtn = headerRow.createEl('button', {
			cls: 'anti-dian-diff-summary-btn',
			attr: { type: 'button' },
		});

		const filesCount = this.diff.files.length;
		leftSummaryBtn.createSpan({
			cls: 'anti-dian-diff-files-count',
			text: `${filesCount} ${filesCount === 1 ? 'file' : 'files'} changed`,
		});

		if (this.diff.totalAdditions > 0) {
			leftSummaryBtn.createSpan({
				cls: 'anti-dian-diff-stat-add',
				text: `+${this.diff.totalAdditions}`,
			});
		}

		if (this.diff.totalDeletions > 0) {
			leftSummaryBtn.createSpan({
				cls: 'anti-dian-diff-stat-del',
				text: `-${this.diff.totalDeletions}`,
			});
		}

		const chevron = leftSummaryBtn.createSpan({
			cls: `anti-dian-diff-chevron collapse-icon ${this.isExpanded ? '' : 'is-collapsed'}`,
		});
		setIcon(chevron, 'right-triangle');

		leftSummaryBtn.onclick = (e) => {
			e.stopPropagation();
			this.isExpanded = !this.isExpanded;
			this.render();
		};

		// Right Action Button
		const rightActions = headerRow.createDiv({
			cls: 'anti-dian-diff-header-actions',
		});

		if (this.isAccepted) {
			const undoBtn = rightActions.createEl('button', {
				cls: 'anti-dian-diff-btn-review',
				attr: { type: 'button' },
			});
			const undoIcon = undoBtn.createSpan({ cls: 'anti-dian-diff-btn-icon' });
			setIcon(undoIcon, 'undo');
			undoBtn.createSpan({ text: 'Undo' });

			undoBtn.onclick = async (e) => {
				e.stopPropagation();
				const confirmed = await confirmAction(this.plugin.app, {
					title: 'Undo applied changes?',
					message: `This restores ${filesCount} ${filesCount === 1 ? 'file' : 'files'} to the state before these changes were applied.`,
					cta: 'Undo',
				});
				if (!confirmed) return;
				undoBtn.disabled = true;
				try {
					await this.plugin.applicator.rollback(this.changeSet.id);
					this.isAccepted = false;
					this.isRejected = true;
					this.render();
				} catch {
					undoBtn.disabled = false;
				}
			};
		} else if (this.isRejected) {
			rightActions.createSpan({
				cls: 'anti-dian-diff-rejected-badge',
				text: 'Rejected',
			});
		} else {
			const reviewBtn = rightActions.createEl('button', {
				cls: 'anti-dian-diff-btn-review',
				attr: { type: 'button' },
			});
			const reviewIcon = reviewBtn.createSpan({ cls: 'anti-dian-diff-btn-icon' });
			setIcon(reviewIcon, 'file-text');
			reviewBtn.createSpan({ text: 'Review' });

			reviewBtn.onclick = (e) => {
				e.stopPropagation();
				this.isExpanded = true;
				// Toggle all diffs expansion
				this.expandedFileIndex = this.expandedFileIndex === null ? 0 : null;
				this.render();
			};
		}

		// File list container
		if (this.isExpanded) {
			const filesList = this.containerEl.createDiv({
				cls: 'anti-dian-diff-files-list',
			});

			for (let i = 0; i < this.diff.files.length; i++) {
				const file = this.diff.files[i];
				if (!file) continue;

				const fileRow = filesList.createDiv({
					cls: `anti-dian-diff-file-row ${this.expandedFileIndex === i ? 'is-selected' : ''}`,
				});

				// Left File Icon
				const iconSpan = fileRow.createSpan({
					cls: 'anti-dian-diff-file-icon',
				});
				setIcon(iconSpan, 'file-text');

				// File Name
				const noteName = file.path.replace(/\.md$/, '').split('/').pop() || file.path;
				const nameEl = fileRow.createSpan({
					cls: 'anti-dian-diff-file-name',
					text: noteName,
				});
				// Hover previews the note and Ctrl/Cmd-click opens it; a plain
				// click keeps toggling the inline diff. New files don't exist yet.
				if (file.operationType !== 'create') {
					bindNoteLink(this.plugin.app, nameEl, {
						path: file.path,
						onPlainClick: () => this.toggleFile(i),
					});
				}

				// Truncated Folder / Directory Subtitle
				const folder = file.path.includes('/')
					? `.../${file.path.split('/').slice(0, -1).join('/')}`
					: '';
				if (folder) {
					fileRow.createSpan({
						cls: 'anti-dian-diff-file-path-sub',
						text: folder,
					});
				}

				// Right Diff Counts (+55 -32)
				const countsSpan = fileRow.createSpan({
					cls: 'anti-dian-diff-file-counts',
				});
				if (file.additions > 0) {
					countsSpan.createSpan({
						cls: 'diff-add',
						text: `+${file.additions}`,
					});
				}
				if (file.deletions > 0) {
					countsSpan.createSpan({
						cls: 'diff-del',
						text: `-${file.deletions}`,
					});
				}

				fileRow.onclick = (e) => {
					e.stopPropagation();
					this.toggleFile(i);
				};

				// Inline diff preview if clicked
				if (this.expandedFileIndex === i) {
					this.renderInlineFileDiff(filesList, file);
				}
			}

			// If in manual 'ask' mode (not read-only 'plan'), provide Apply & Reject buttons at bottom
			const mode = this.plugin.settings.permissionMode ?? 'ask';
			if (!this.isAccepted && !this.isRejected && mode !== 'plan') {
				const bottomBar = this.containerEl.createDiv({
					cls: 'anti-dian-diff-bottom-bar',
				});

				const applyLabel = `Apply ${filesCount} ${filesCount === 1 ? 'change' : 'changes'}`;

				const rejectBtn = new ButtonComponent(bottomBar)
					.setClass('anti-dian-btn-reject')
					.setButtonText('Reject')
					.onClick(() => {
						this.plugin.stagingManager.setStatus(this.changeSet.id, 'rejected');
						this.isRejected = true;
						this.render();
					});

				const applyBtn = new ButtonComponent(bottomBar)
					.setClass('anti-dian-btn-apply')
					.setCta()
					.setButtonText(applyLabel)
					.onClick(async () => {
						applyBtn.setDisabled(true).setButtonText('Applying...');
						rejectBtn.setDisabled(true);

						try {
							await this.plugin.applicator.apply(this.changeSet);
							this.isAccepted = true;
							this.render();
						} catch {
							applyBtn.setDisabled(false).setButtonText(applyLabel);
							rejectBtn.setDisabled(false);
						}
					});
			}
		}
	}

	private toggleFile(index: number): void {
		this.expandedFileIndex = this.expandedFileIndex === index ? null : index;
		this.render();
	}

	private renderInlineFileDiff(container: HTMLElement, file: FileDiff): void {
		const diffBox = container.createDiv({
			cls: 'anti-dian-diff-inline-box',
		});

		for (const hunk of file.hunks) {
			if (hunk.header) {
				diffBox.createDiv({
					text: hunk.header,
					cls: 'anti-dian-diff-line diff-hunk-header',
				});
			}
			for (const line of hunk.lines) {
				const lineEl = diffBox.createDiv({
					cls: `anti-dian-diff-line diff-${line.type}`,
				});
				const prefix =
					line.type === 'added'
						? '+'
						: line.type === 'removed'
							? '-'
							: ' ';
				lineEl.setText(`${prefix} ${line.content}`);
			}
		}
	}
}

interface ConfirmOptions {
	title: string;
	message: string;
	cta: string;
}

/** Native confirmation dialog; resolves true only when the CTA is pressed. */
function confirmAction(app: App, opts: ConfirmOptions): Promise<boolean> {
	return new Promise((resolve) => {
		let confirmed = false;
		const modal = new Modal(app);
		modal.setTitle(opts.title);
		modal.contentEl.createEl('p', { text: opts.message });
		new Setting(modal.contentEl)
			.addButton((btn) =>
				btn.setButtonText('Cancel').onClick(() => modal.close()),
			)
			.addButton((btn) =>
				btn
					.setButtonText(opts.cta)
					.setWarning()
					.onClick(() => {
						confirmed = true;
						modal.close();
					}),
			);
		modal.onClose = () => resolve(confirmed);
		modal.open();
	});
}
