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
		return await this.mutationService.apply(changeSet);
	}

	async rollback(changeSetId: string): Promise<RollbackResult> {
		const snapshot = this.snapshots.get(changeSetId);
		if (!snapshot) {
			throw new Error(`No before-state snapshot found for ChangeSet ${changeSetId}`);
		}

		return await this.mutationService.rollback(snapshot);
	}

	getSnapshot(changeSetId: string): ChangeSetSnapshot | undefined {
		return this.snapshots.get(changeSetId);
	}
}
