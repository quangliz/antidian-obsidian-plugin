import { Notice } from 'obsidian';
import type AntiDianPlugin from '../../main';

export function registerCommands(plugin: AntiDianPlugin): void {
	plugin.addCommand({
		id: 'open-sidebar',
		name: 'Open sidebar',
		callback: () => {
			void plugin.activateView();
		},
	});

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
