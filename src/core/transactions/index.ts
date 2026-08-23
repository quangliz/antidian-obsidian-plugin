import { ChangeOperation, ChangeSet } from '../types/changes';

export * from './validator';

export class ChangeStagingManager {
	private changeSets: Map<string, ChangeSet> = new Map();
	private activeChangeSetId: string | null = null;

	startTurn(): ChangeSet {
		const id = `cs_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
		const changeSet: ChangeSet = {
			id,
			operations: [],
			createdAt: Date.now(),
			status: 'staged',
		};
		this.changeSets.set(id, changeSet);
		this.activeChangeSetId = id;
		return changeSet;
	}

	stage(op: ChangeOperation, changeSetId?: string): ChangeSet {
		const targetId = changeSetId ?? this.activeChangeSetId;
		let changeSet: ChangeSet | undefined;

		if (targetId) {
			changeSet = this.changeSets.get(targetId);
		}

		if (!changeSet || changeSet.status !== 'staged') {
			changeSet = this.startTurn();
		}

		changeSet.operations.push(op);
		return changeSet;
	}

	get(id: string): ChangeSet | undefined {
		return this.changeSets.get(id);
	}

	getActive(): ChangeSet | null {
		return this.activeChangeSetId
			? this.changeSets.get(this.activeChangeSetId) ?? null
			: null;
	}

	getLatestStaged(): ChangeSet | null {
		const staged = Array.from(this.changeSets.values()).filter(
			(cs) => cs.status === 'staged' && cs.operations.length > 0,
		);
		return staged.length > 0 ? (staged[staged.length - 1] ?? null) : null;
	}

	setStatus(id: string, status: ChangeSet['status']): boolean {
		const cs = this.changeSets.get(id);
		if (!cs) return false;
		cs.status = status;
		if (this.activeChangeSetId === id && status !== 'staged') {
			this.activeChangeSetId = null;
		}
		return true;
	}

	getAffectedFiles(changeSet: ChangeSet): string[] {
		const files = new Set<string>();
		for (const op of changeSet.operations) {
			files.add(op.path);
		}
		return Array.from(files);
	}

	list(): ChangeSet[] {
		return Array.from(this.changeSets.values());
	}
}
