import type {
	AppliedChangeSet,
	ChangeSet,
	ChangeSetSnapshot,
	MutationService,
	RollbackResult,
} from '../types/changes';
import type { ChangeSetValidator } from './validator';

export class ChangeSetApplicator {
	private mutationService: MutationService;
	private validator?: ChangeSetValidator;
	private snapshots: Map<string, ChangeSetSnapshot> = new Map();
	private appliedOrder: string[] = [];

	constructor(
		mutationService: MutationService,
		validator?: ChangeSetValidator,
	) {
		this.mutationService = mutationService;
		this.validator = validator;
	}

	async apply(changeSet: ChangeSet): Promise<AppliedChangeSet> {
		if (this.validator) {
			const validation = await this.validator.validate(changeSet);
			if (!validation.valid) {
				const msgs = validation.errors
					.map((e) => `[${e.code}] ${e.message}`)
					.join(', ');
				throw new Error(`ChangeSet validation failed: ${msgs}`);
			}
		}

		// 1. Capture before-state snapshot before any file modification
		const snapshot = await this.mutationService.captureSnapshot(changeSet);
		this.snapshots.set(changeSet.id, snapshot);

		// 2. Apply the operations to vault
		const applied = await this.mutationService.apply(changeSet);
		this.appliedOrder.push(changeSet.id);
		return applied;
	}

	async rollback(changeSetId: string): Promise<RollbackResult> {
		const snapshot = this.snapshots.get(changeSetId);
		if (!snapshot) {
			throw new Error(`No before-state snapshot found for ChangeSet ${changeSetId}`);
		}

		const result = await this.mutationService.rollback(snapshot);
		if (result.success) {
			this.snapshots.delete(changeSetId);
			const idx = this.appliedOrder.lastIndexOf(changeSetId);
			if (idx !== -1) this.appliedOrder.splice(idx, 1);
		}
		return result;
	}

	getLastUndoableChangeSetId(): string | undefined {
		for (let i = this.appliedOrder.length - 1; i >= 0; i--) {
			const id = this.appliedOrder[i];
			if (id && this.snapshots.has(id)) return id;
		}
		return undefined;
	}

	async rollbackLast(): Promise<{
		changeSetId: string;
		result: RollbackResult;
	} | null> {
		const id = this.getLastUndoableChangeSetId();
		if (!id) return null;
		const result = await this.rollback(id);
		return { changeSetId: id, result };
	}

	getSnapshot(changeSetId: string): ChangeSetSnapshot | undefined {
		return this.snapshots.get(changeSetId);
	}
}
