import { ChangeSet, ChangeSetDiff } from '../../core/types/changes';
import { ChangeSetValidator } from '../../core/transactions';
import type AntiDianPlugin from '../../main';
import { ChangeApprovalBar } from './change-approval-view';

/**
 * Validate and diff a turn's ChangeSet, then render its approval bar.
 * Returns the diff so the caller can show it on the trace's tool rows,
 * or null when validation failed (errors are rendered instead).
 */
export async function renderChangeSet(
	parent: HTMLElement,
	changeSet: ChangeSet,
	plugin: AntiDianPlugin,
	onReview: () => void,
	validator?: ChangeSetValidator,
): Promise<ChangeSetDiff | null> {
	if (validator) {
		const valRes = await validator.validate(changeSet);
		if (!valRes.valid) {
			const errList = parent.createDiv({
				cls: 'anti-dian-changeset-errors',
			});
			for (const err of valRes.errors) {
				errList.createDiv({
					text: `[${err.code}] ${err.message}`,
					cls: 'anti-dian-changeset-error-item',
				});
			}
			return null;
		}
	}

	let diff: ChangeSetDiff;
	try {
		diff = await plugin.diffGenerator.generate(changeSet);
	} catch {
		return null;
	}

	new ChangeApprovalBar(parent, changeSet, diff, plugin, onReview);
	return diff;
}
