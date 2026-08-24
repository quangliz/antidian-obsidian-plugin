import { ChangeSet, FileDiff, ChangeSetDiff } from '../../core/types/changes';
import { ChangeSetValidator } from '../../core/transactions';
import type AntiDianPlugin from '../../main';

export async function renderChangeSet(
	parent: HTMLElement,
	changeSet: ChangeSet,
	plugin: AntiDianPlugin,
	validator?: ChangeSetValidator,
): Promise<void> {
	const card = parent.createDiv({ cls: 'anti-dian-changeset-card' });

	const header = card.createDiv({ cls: 'anti-dian-changeset-header' });
	header.createSpan({
		text: 'Proposed changes',
		cls: 'anti-dian-changeset-title',
	});

	const badge = header.createSpan({
		cls: 'anti-dian-changeset-badge',
	});

	let validation = {
		valid: true,
		errors: [] as { code: string; message: string }[],
	};
	if (validator) {
		const valRes = await validator.validate(changeSet);
		validation = {
			valid: valRes.valid,
			errors: valRes.errors.map((e) => ({
				code: e.code,
				message: e.message,
			})),
		};
	}

	if (validation.valid) {
		badge.setText('Validated');
		badge.addClass('anti-dian-badge-valid');
	} else {
		badge.setText('Invalid');
		badge.addClass('anti-dian-badge-invalid');
	}

	if (!validation.valid && validation.errors.length > 0) {
		const errList = card.createDiv({
			cls: 'anti-dian-changeset-errors',
		});
		for (const err of validation.errors) {
			errList.createDiv({
				text: `[${err.code}] ${err.message}`,
				cls: 'anti-dian-changeset-error-item',
			});
		}
	}

	let diff: ChangeSetDiff | null = null;
	try {
		diff = await plugin.diffGenerator.generate(changeSet);
	} catch {
		// fallback
	}

	const opsList = card.createDiv({ cls: 'anti-dian-changeset-ops-list' });

	for (const op of changeSet.operations) {
		const opItem = opsList.createDiv({
			cls: 'anti-dian-changeset-op-item',
		});

		const isCreate = op.type === 'create';
		opItem.createSpan({
			text: isCreate ? '+' : '~',
			cls: `anti-dian-op-prefix anti-dian-op-${isCreate ? 'create' : 'patch'}`,
		});

		opItem.createSpan({
			text: op.path,
			cls: 'anti-dian-op-path',
		});

		const fileDiff = diff?.files.find((f) => f.path === op.path);
		if (fileDiff) {
			const counts = opItem.createSpan({
				cls: 'anti-dian-op-diff-counts',
			});
			if (fileDiff.additions > 0) {
				counts.createSpan({
					text: `+${fileDiff.additions}`,
					cls: 'anti-dian-diff-count-add',
				});
			}
			if (fileDiff.deletions > 0) {
				counts.createSpan({
					text: `-${fileDiff.deletions}`,
					cls: 'anti-dian-diff-count-del',
				});
			}
		}

		const singleDiffBox = card.createDiv({
			cls: 'anti-dian-single-file-diff anti-dian-hidden',
		});
		if (fileDiff) {
			renderFileDiffContent(singleDiffBox, fileDiff);
		}

		opItem.onclick = () => {
			const isHidden = singleDiffBox.hasClass('anti-dian-hidden');
			if (isHidden) {
				singleDiffBox.removeClass('anti-dian-hidden');
				opItem.addClass('is-selected');
			} else {
				singleDiffBox.addClass('anti-dian-hidden');
				opItem.removeClass('is-selected');
			}
		};
	}

	const diffContainer = card.createDiv({
		cls: 'anti-dian-full-diff-container anti-dian-hidden',
	});
	if (diff) {
		renderDiffPreview(diffContainer, diff);
	}

	const reviewBtnRow = card.createDiv({
		cls: 'anti-dian-review-btn-row',
	});
	const reviewBtn = reviewBtnRow.createEl('button', {
		text: 'Review changes',
		cls: 'anti-dian-btn-review',
	});
	reviewBtn.onclick = () => {
		if (diffContainer.hasClass('anti-dian-hidden')) {
			diffContainer.removeClass('anti-dian-hidden');
			reviewBtn.setText('Hide review');
		} else {
			diffContainer.addClass('anti-dian-hidden');
			reviewBtn.setText('Review changes');
		}
	};

	const mode = plugin.settings.permissionMode ?? 'ask';

	if (mode === 'plan') {
		badge.setText('Plan only');
		badge.className = 'anti-dian-changeset-badge anti-dian-badge-valid';
		const planNotice = card.createDiv({
			cls: 'anti-dian-changeset-result-notice anti-dian-notice-plan',
		});
		planNotice.setText('Plan mode: mutations are not applied to vault');
	} else if (mode === 'auto' && validation.valid) {
		try {
			const applied = await plugin.applicator.apply(changeSet);
			badge.setText('Auto-applied');
			badge.className =
				'anti-dian-changeset-badge anti-dian-badge-valid';
			const resultNotice = card.createDiv({
				cls: 'anti-dian-changeset-result-notice anti-dian-notice-applied',
			});
			resultNotice.createSpan({
				text: `Auto-applied ${applied.operations.length} ${applied.operations.length === 1 ? 'change' : 'changes'}`,
				cls: 'anti-dian-notice-msg',
			});

			const undoBtn = resultNotice.createEl('button', {
				text: 'Undo',
				cls: 'anti-dian-btn-undo',
			});

			undoBtn.onclick = async () => {
				undoBtn.disabled = true;
				undoBtn.setText('Undoing...');
				try {
					const rollbackRes =
						await plugin.applicator.rollback(changeSet.id);
					badge.setText('Rolled back');
					badge.className =
						'anti-dian-changeset-badge anti-dian-badge-invalid';
					resultNotice.className =
						'anti-dian-changeset-result-notice anti-dian-notice-rejected';
					resultNotice.empty();
					resultNotice.setText(
						`Undid ${rollbackRes.restoredCount} ${rollbackRes.restoredCount === 1 ? 'change' : 'changes'}`,
					);
				} catch (undoErr) {
					undoBtn.disabled = false;
					undoBtn.setText('Undo');
					const errEl = card.createDiv({
						cls: 'anti-dian-changeset-errors',
					});
					errEl.createDiv({
						text: `Notice: ${undoErr instanceof Error ? undoErr.message : String(undoErr)}`,
						cls: 'anti-dian-changeset-error-item',
					});
				}
			};
		} catch (autoErr) {
			const errEl = card.createDiv({
				cls: 'anti-dian-changeset-errors',
			});
			errEl.createDiv({
				text: `Notice: Auto-apply failed: ${autoErr instanceof Error ? autoErr.message : String(autoErr)}`,
				cls: 'anti-dian-changeset-error-item',
			});
		}
	} else {
		const actionsRow = card.createDiv({
			cls: 'anti-dian-changeset-actions-row',
		});

		const rejectBtn = actionsRow.createEl('button', {
			text: 'Reject',
			cls: 'anti-dian-btn-reject',
		});

		const applyBtn = actionsRow.createEl('button', {
			text: 'Apply',
			cls: 'anti-dian-btn-apply mod-cta',
		});

		const resultNotice = card.createDiv({
			cls: 'anti-dian-changeset-result-notice anti-dian-hidden',
		});

		rejectBtn.onclick = () => {
			plugin.stagingManager.setStatus(changeSet.id, 'rejected');
			badge.setText('Rejected');
			badge.className =
				'anti-dian-changeset-badge anti-dian-badge-invalid';
			actionsRow.addClass('anti-dian-hidden');
			reviewBtnRow.addClass('anti-dian-hidden');
			resultNotice.removeClass('anti-dian-hidden');
			resultNotice.setText('Changes rejected');
			resultNotice.className =
				'anti-dian-changeset-result-notice anti-dian-notice-rejected';
		};

		applyBtn.onclick = async () => {
			applyBtn.disabled = true;
			rejectBtn.disabled = true;
			applyBtn.setText('Applying...');

			try {
				const applied = await plugin.applicator.apply(changeSet);
				badge.setText('Applied');
				badge.className =
					'anti-dian-changeset-badge anti-dian-badge-valid';
				actionsRow.addClass('anti-dian-hidden');
				reviewBtnRow.addClass('anti-dian-hidden');
				resultNotice.removeClass('anti-dian-hidden');
				resultNotice.empty();

				resultNotice.createSpan({
					text: `Applied ${applied.operations.length} ${applied.operations.length === 1 ? 'change' : 'changes'}`,
					cls: 'anti-dian-notice-msg',
				});

				const undoBtn = resultNotice.createEl('button', {
					text: 'Undo',
					cls: 'anti-dian-btn-undo',
				});

				undoBtn.onclick = async () => {
					undoBtn.disabled = true;
					undoBtn.setText('Undoing...');
					try {
						const rollbackRes =
							await plugin.applicator.rollback(changeSet.id);
						badge.setText('Rolled back');
						badge.className =
							'anti-dian-changeset-badge anti-dian-badge-invalid';
						resultNotice.className =
							'anti-dian-changeset-result-notice anti-dian-notice-rejected';
						resultNotice.empty();
						resultNotice.setText(
							`Undid ${rollbackRes.restoredCount} ${rollbackRes.restoredCount === 1 ? 'change' : 'changes'}`,
						);
					} catch (undoErr) {
						undoBtn.disabled = false;
						undoBtn.setText('Undo');
						const errEl = card.createDiv({
							cls: 'anti-dian-changeset-errors',
						});
						errEl.createDiv({
							text: `Notice: ${undoErr instanceof Error ? undoErr.message : String(undoErr)}`,
							cls: 'anti-dian-changeset-error-item',
						});
					}
				};

				resultNotice.className =
					'anti-dian-changeset-result-notice anti-dian-notice-applied';
			} catch (err) {
				applyBtn.disabled = false;
				rejectBtn.disabled = false;
				applyBtn.setText('Apply');
				const errEl = card.createDiv({
					cls: 'anti-dian-changeset-errors',
				});
				errEl.createDiv({
					text: `Notice: ${err instanceof Error ? err.message : String(err)}`,
					cls: 'anti-dian-changeset-error-item',
				});
			}
		};
	}
}

export function renderFileDiffContent(
	container: HTMLElement,
	file: FileDiff,
): void {
	const diffBox = container.createDiv({ cls: 'anti-dian-diff-preview' });

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

export function renderDiffPreview(
	container: HTMLElement,
	diff: ChangeSetDiff,
): void {
	const summary = container.createDiv({ cls: 'anti-dian-diff-summary' });
	summary.createSpan({
		text: `${diff.files.length} ${diff.files.length === 1 ? 'file' : 'files'} changed`,
		cls: 'anti-dian-diff-summary-text',
	});
	if (diff.totalAdditions > 0) {
		summary.createSpan({
			text: `+${diff.totalAdditions}`,
			cls: 'anti-dian-diff-count-add',
		});
	}
	if (diff.totalDeletions > 0) {
		summary.createSpan({
			text: `-${diff.totalDeletions}`,
			cls: 'anti-dian-diff-count-del',
		});
	}

	for (const file of diff.files) {
		const fileCard = container.createDiv({
			cls: 'anti-dian-diff-file-card',
		});

		const fileHeader = fileCard.createDiv({
			cls: 'anti-dian-diff-file-header',
		});
		fileHeader.createSpan({
			text: file.path,
			cls: 'anti-dian-diff-file-path',
		});

		if (file.heading) {
			fileHeader.createSpan({
				text: ` > #${file.heading}`,
				cls: 'anti-dian-diff-file-heading',
			});
		}

		const countsSpan = fileHeader.createSpan({
			cls: 'anti-dian-op-diff-counts',
		});
		if (file.additions > 0) {
			countsSpan.createSpan({
				text: `+${file.additions}`,
				cls: 'anti-dian-diff-count-add',
			});
		}
		if (file.deletions > 0) {
			countsSpan.createSpan({
				text: `-${file.deletions}`,
				cls: 'anti-dian-diff-count-del',
			});
		}

		renderFileDiffContent(fileCard, file);
	}
}
