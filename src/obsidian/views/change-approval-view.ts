import { App, ButtonComponent, Modal, Setting, setIcon } from 'obsidian';
import { ChangeSet, ChangeSetDiff } from '../../core/types/changes';
import type AntiDianPlugin from '../../main';

/**
 * Approval bar for a turn's ChangeSet. The diffs themselves live in the
 * thinking trace, on the tool row that staged each change; this bar only
 * summarizes them and holds Apply / Reject / Undo.
 */
export class ChangeApprovalBar {
	private plugin: AntiDianPlugin;
	private changeSet: ChangeSet;
	private diff: ChangeSetDiff;
	private onReview: () => void;
	private containerEl: HTMLElement;
	private state: 'pending' | 'applying' | 'applied' | 'rejected' = 'pending';
	private appliedAutomatically = false;
	private error: string | null = null;

	constructor(
		parentEl: HTMLElement,
		changeSet: ChangeSet,
		diff: ChangeSetDiff,
		plugin: AntiDianPlugin,
		onReview: () => void,
	) {
		this.containerEl = parentEl.createDiv({ cls: 'anti-dian-change-bar' });
		this.changeSet = changeSet;
		this.diff = diff;
		this.plugin = plugin;
		this.onReview = onReview;

		this.render();
		if ((this.plugin.settings.permissionMode ?? 'ask') === 'auto') {
			this.appliedAutomatically = true;
			void this.apply();
		}
	}

	private get fileCount(): number {
		return new Set(this.diff.files.map((f) => f.path)).size;
	}

	private async apply(): Promise<void> {
		this.state = 'applying';
		this.error = null;
		this.render();
		try {
			await this.plugin.applicator.apply(this.changeSet);
			this.state = 'applied';
		} catch (err) {
			this.state = 'pending';
			this.appliedAutomatically = false;
			this.error = err instanceof Error ? err.message : String(err);
		}
		this.render();
	}

	private render(): void {
		const el = this.containerEl;
		el.empty();
		el.toggleClass('is-settled', this.state === 'applied' || this.state === 'rejected');

		// Summary: "1 file changed +2 -1" — clicking reveals the diffs in the trace.
		const summary = el.createEl('button', {
			cls: 'anti-dian-change-bar-summary',
			attr: { type: 'button' },
		});
		const icon = summary.createSpan({ cls: 'anti-dian-change-bar-icon' });
		setIcon(icon, 'file-diff');
		const files = this.fileCount;
		summary.createSpan({ text: `${files} ${files === 1 ? 'file' : 'files'} changed` });
		if (this.diff.totalAdditions > 0) {
			summary.createSpan({ cls: 'anti-dian-diff-stat-add', text: `+${this.diff.totalAdditions}` });
		}
		if (this.diff.totalDeletions > 0) {
			summary.createSpan({ cls: 'anti-dian-diff-stat-del', text: `-${this.diff.totalDeletions}` });
		}
		summary.onclick = (e) => {
			e.stopPropagation();
			this.onReview();
		};

		const actions = el.createDiv({ cls: 'anti-dian-change-bar-actions' });

		if (this.state === 'applied') {
			actions.createSpan({
				cls: 'anti-dian-change-bar-status is-applied',
				text: this.appliedAutomatically ? 'Applied automatically' : 'Applied',
			});
			new ButtonComponent(actions)
				.setIcon('undo')
				.setTooltip('Undo')
				.setClass('anti-dian-change-bar-undo')
				.onClick(() => void this.undo());
			return;
		}

		if (this.state === 'rejected') {
			actions.createSpan({ cls: 'anti-dian-change-bar-status', text: 'Rejected' });
			return;
		}

		if (this.error) {
			el.createDiv({ cls: 'anti-dian-change-bar-error', text: this.error });
		}

		const busy = this.state === 'applying';
		const changes = this.diff.files.length;
		new ButtonComponent(actions)
			.setButtonText('Reject')
			.setDisabled(busy)
			.onClick(() => {
				this.plugin.stagingManager.setStatus(this.changeSet.id, 'rejected');
				this.state = 'rejected';
				this.render();
			});
		new ButtonComponent(actions)
			.setCta()
			.setDisabled(busy)
			.setButtonText(
				busy ? 'Applying…' : `Apply ${changes} ${changes === 1 ? 'change' : 'changes'}`,
			)
			.onClick(() => void this.apply());
	}

	private async undo(): Promise<void> {
		const files = this.fileCount;
		const confirmed = await confirmAction(this.plugin.app, {
			title: 'Undo applied changes?',
			message: `This restores ${files} ${files === 1 ? 'file' : 'files'} to the state before these changes were applied.`,
			cta: 'Undo',
		});
		if (!confirmed) return;
		try {
			await this.plugin.applicator.rollback(this.changeSet.id);
			this.state = 'rejected';
			this.error = null;
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
		}
		this.render();
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
			.addButton((btn) => btn.setButtonText('Cancel').onClick(() => modal.close()))
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
