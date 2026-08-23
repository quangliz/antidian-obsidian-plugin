import {
	AppliedChangeSet,
	ChangeSet,
	MutationService,
} from '../types/changes';
import { ChangeSetValidator } from './validator';

export class ChangeSetApplicator {
	private mutationService: MutationService;
	private validator?: ChangeSetValidator;

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

		return await this.mutationService.apply(changeSet);
	}
}
