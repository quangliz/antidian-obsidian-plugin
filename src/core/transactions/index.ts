import { ChangeOperation, ChangeSet } from '../types/changes';

export class ChangeStagingManager {
	private currentChangeSet: ChangeSet | null = null;
	private history: ChangeSet[] = [];

	stage(op: ChangeOperation): ChangeSet {
		if (!this.currentChangeSet || this.currentChangeSet.status !== 'staged') {
			this.currentChangeSet = {
				id: `changeset_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
				operations: [],
				status: 'staged',
				createdAt: Date.now(),
			};
		}
		this.currentChangeSet.operations.push(op);
		return this.currentChangeSet;
	}

	getCurrent(): ChangeSet | null {
		return this.currentChangeSet;
	}

	getStagedOperations(): ChangeOperation[] {
		return this.currentChangeSet?.operations ?? [];
	}

	clear(): void {
		this.currentChangeSet = null;
	}

	recordHistory(changeSet: ChangeSet): void {
		this.history.push(changeSet);
	}

	getHistory(): ChangeSet[] {
		return [...this.history];
	}
}
