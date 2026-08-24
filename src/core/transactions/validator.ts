import {
	ChangeSet,
	ValidationError,
	ValidationResult,
} from '../types/changes';
import { VaultInspectionService } from '../types/vault';

export class ChangeSetValidator {
	private inspector: VaultInspectionService;

	constructor(inspector: VaultInspectionService) {
		this.inspector = inspector;
	}

	async validate(changeSet: ChangeSet): Promise<ValidationResult> {
		const errors: ValidationError[] = [];
		const seenCreatedPaths = new Set<string>();
		const seenPatchedSections = new Set<string>();

		for (let i = 0; i < changeSet.operations.length; i++) {
			const op = changeSet.operations[i];
			if (!op) continue;

			// 1. Path boundary check
			if (!this.inspector.isPathWithinVault(op.path)) {
				errors.push({
					operationIndex: i,
					path: op.path,
					code: 'path_traversal',
					message: `Path escapes vault boundary: "${op.path}"`,
				});
				continue;
			}

			const normPath = this.inspector.normalizePath(op.path);

			// 2. Content validation
			if (typeof op.content !== 'string') {
				errors.push({
					operationIndex: i,
					path: normPath,
					code: 'invalid_content',
					message: `Content must be a valid string for operation on "${normPath}"`,
				});
			}

			if (op.type === 'create') {
				// 3. Intra-ChangeSet duplicate creates
				if (seenCreatedPaths.has(normPath)) {
					errors.push({
						operationIndex: i,
						path: normPath,
						code: 'operation_conflict',
						message: `Conflicting duplicate create operation for "${normPath}"`,
					});
				}
				seenCreatedPaths.add(normPath);

				// 4. Create overwrite check
				const exists = await this.inspector.fileExists(normPath);
				if (exists) {
					errors.push({
						operationIndex: i,
						path: normPath,
						code: 'file_already_exists',
						message: `Cannot create note because file already exists: "${normPath}"`,
					});
				}
			} else if (op.type === 'patch-section') {
				const headingClean = op.heading.trim().toLowerCase();
				const sectionKey = `${normPath}#${headingClean}`;

				// 5. Intra-ChangeSet duplicate patch to same section
				if (seenPatchedSections.has(sectionKey)) {
					errors.push({
						operationIndex: i,
						path: normPath,
						code: 'operation_conflict',
						message: `Conflicting duplicate patch for heading "${op.heading}" in "${normPath}"`,
					});
				}
				seenPatchedSections.add(sectionKey);

				// 6. Target note existence
				const exists = await this.inspector.fileExists(normPath);
				if (!exists) {
					errors.push({
						operationIndex: i,
						path: normPath,
						code: 'file_not_found',
						message: `Target note does not exist: "${normPath}"`,
					});
				} else {
					// 7. Heading existence
					const hasHeading = await this.inspector.headingExists(
						normPath,
						op.heading,
					);
					if (!hasHeading) {
						errors.push({
							operationIndex: i,
							path: normPath,
							code: 'heading_not_found',
							message: `Heading "# ${op.heading}" not found in note "${normPath}"`,
						});
					}

					// 8. Stale base / concurrent edit check
					if (op.baseMtime !== undefined) {
						const currentMtime =
							await this.inspector.getFileMtime(normPath);
						if (
							currentMtime !== null &&
							currentMtime > op.baseMtime
						) {
							errors.push({
								operationIndex: i,
								path: normPath,
								code: 'stale_base',
								message: `File "${normPath}" was modified after it was read by the agent (stale base).`,
							});
						}
					}
				}
			} else if (op.type === 'edit') {
				// 9. Target note existence for edit
				const exists = await this.inspector.fileExists(normPath);
				if (!exists) {
					errors.push({
						operationIndex: i,
						path: normPath,
						code: 'file_not_found',
						message: `Target note does not exist for edit: "${normPath}"`,
					});
				} else if (op.baseMtime !== undefined) {
					const currentMtime =
						await this.inspector.getFileMtime(normPath);
					if (
						currentMtime !== null &&
						currentMtime > op.baseMtime
					) {
						errors.push({
							operationIndex: i,
							path: normPath,
							code: 'stale_base',
							message: `File "${normPath}" was modified after it was read by the agent (stale base).`,
						});
					}
				}
			}
		}

		return {
			valid: errors.length === 0,
			errors,
		};
	}
}
