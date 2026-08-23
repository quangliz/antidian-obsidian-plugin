import { ChangeSet } from '../types/changes';
import { VaultService } from '../types/vault';
import { ChangeSetValidator } from './validator';

export interface ApplyResult {
	success: boolean;
	appliedCount: number;
	errors: string[];
}

export class ChangeSetApplicator {
	private vaultService: VaultService;
	private validator?: ChangeSetValidator;

	constructor(vaultService: VaultService, validator?: ChangeSetValidator) {
		this.vaultService = vaultService;
		this.validator = validator;
	}

	async apply(changeSet: ChangeSet): Promise<ApplyResult> {
		if (this.validator) {
			const validation = await this.validator.validate(changeSet);
			if (!validation.valid) {
				return {
					success: false,
					appliedCount: 0,
					errors: validation.errors.map(
						(e) => `[${e.code}] ${e.message}`,
					),
				};
			}
		}

		const errors: string[] = [];
		let appliedCount = 0;

		for (const op of changeSet.operations) {
			try {
				if (op.type === 'create') {
					await this.vaultService.createNote(op.path, op.content);
					appliedCount++;
				} else if (op.type === 'patch-section') {
					await this.vaultService.patchSection(
						op.path,
						op.heading,
						op.content,
					);
					appliedCount++;
				}
			} catch (err) {
				errors.push(
					`Failed on ${op.path}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		const success = errors.length === 0;
		changeSet.status = success ? 'applied' : 'staged';

		return {
			success,
			appliedCount,
			errors,
		};
	}
}
