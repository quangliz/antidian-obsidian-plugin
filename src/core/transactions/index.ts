import type { ChangeOperation, ChangeSet } from '../types/changes';

export * from './markdown';
export * from './overlay';
export * from './validator';
export * from './diff';
export * from './applicator';
export * from './gate';

export class ChangeStagingManager {
	private changeSets: Map<string, ChangeSet> = new Map();
	private activeChangeSetId: string | null = null;
	private opCounter = 0;

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

		op.id ??= `op_${++this.opCounter}`;
		changeSet.operations.push(op);
		return changeSet;
	}

	/** Take a staged operation out of its ChangeSet (to review it on its own). */
	removeOperation(changeSetId: string, opId: string): ChangeOperation | undefined {
		const changeSet = this.changeSets.get(changeSetId);
		if (!changeSet) return undefined;
		const index = changeSet.operations.findIndex((op) => op.id === opId);
		if (index < 0) return undefined;
		const [op] = changeSet.operations.splice(index, 1);
		return op;
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
