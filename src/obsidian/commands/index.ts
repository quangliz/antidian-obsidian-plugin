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
}
