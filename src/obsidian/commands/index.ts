import { Notice } from 'obsidian';
import type AntidianPlugin from '../../main';
import { ANTIDIAN_ICON } from '../icon';

export function registerCommands(plugin: AntidianPlugin): void {
	plugin.addCommand({
		id: 'open-sidebar',
		name: 'Open sidebar',
		callback: () => {
			void plugin.activateView();
		},
	});

	plugin.addCommand({
		id: 'add-selection-to-chat',
		name: 'Add selection to chat',
		editorCheckCallback: (checking, editor, ctx) => {
			const selected = editor.getSelection();
			if (!selected || !selected.trim()) return false;
			if (!checking) {
				const from = editor.getCursor('from');
				const to = editor.getCursor('to');
				void plugin.addSelectionToChat({
					text: selected,
					filePath: ctx.file?.path,
					startLine: from.line + 1,
					endLine: to.line + 1,
				});
			}
			return true;
		},
	});

	plugin.registerEvent(
		plugin.app.workspace.on('editor-menu', (menu, editor, info) => {
			const selected = editor.getSelection();
			if (!selected || !selected.trim()) return;
			const from = editor.getCursor('from');
			const to = editor.getCursor('to');
			const filePath = info.file?.path;
			menu.addItem((item) => {
				item
					.setTitle(`Add to ${plugin.manifest.name}`)
					.setIcon(ANTIDIAN_ICON)
					.onClick(() => {
						void plugin.addSelectionToChat({
							text: selected,
							filePath,
							startLine: from.line + 1,
							endLine: to.line + 1,
						});
					});
			});
		}),
	);

	plugin.addCommand({
		id: 'accept-inline-diff',
		name: 'Accept pending inline diff change',
		checkCallback: (checking) => {
			if (!plugin.inlineDiffController.hasPendingReviewForActiveFile()) {
				return false;
			}
			if (!checking) {
				plugin.inlineDiffController.resolveActiveReview('approve');
			}
			return true;
		},
	});

	plugin.addCommand({
		id: 'reject-inline-diff',
		name: 'Reject pending inline diff change',
		checkCallback: (checking) => {
			if (!plugin.inlineDiffController.hasPendingReviewForActiveFile()) {
				return false;
			}
			if (!checking) {
				plugin.inlineDiffController.resolveActiveReview('reject');
			}
			return true;
		},
	});

	plugin.addCommand({
		id: 'undo-last-change',
		name: 'Undo last agent change',
		checkCallback: (checking) => {
			if (!plugin.applicator.getLastUndoableChangeSetId()) {
				return false;
			}
			if (!checking) {
				void plugin.applicator
					.rollbackLast()
					.then((res) => {
						if (res?.result.success) {
							new Notice('Reverted last agent change.');
						} else if (res) {
							new Notice(
								`Undo failed: ${res.result.errors.join('; ') || 'unknown error'}`,
							);
						}
					})
					.catch((err) => {
						new Notice(
							`Undo failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					});
			}
			return true;
		},
	});
}
