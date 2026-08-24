import { ChangeSet } from '../../core/types/changes';
import { ChangeSetValidator } from '../../core/transactions';
import type AntiDianPlugin from '../../main';
import { DiffTableView } from './diff-table-view';

export async function renderChangeSet(
	parent: HTMLElement,
	changeSet: ChangeSet,
	plugin: AntiDianPlugin,
	validator?: ChangeSetValidator,
): Promise<void> {
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
			return;
		}
	}

	let diff = null;
	try {
		diff = await plugin.diffGenerator.generate(changeSet);
	} catch {
		// fallback
	}

	if (!diff) return;

	new DiffTableView(parent, changeSet, diff, plugin);
}
