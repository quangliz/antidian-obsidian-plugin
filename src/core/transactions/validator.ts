import type {
	ChangeSet,
	ValidationError,
	ValidationResult,
} from '../types/changes';
import type { VaultInspectionService, VaultService } from '../types/vault';
import { applyOperationToContent } from './overlay';

type ValidatorVault = VaultInspectionService &
	Partial<Pick<VaultService, 'readNote'>>;

export class ChangeSetValidator {
	private inspector: ValidatorVault;

	constructor(inspector: ValidatorVault) {
		this.inspector = inspector;
	}

	async validate(changeSet: ChangeSet): Promise<ValidationResult> {
		const errors: ValidationError[] = [];
		const seenCreatedPaths = new Set<string>();
		const virtualContents = new Map<string, string | null>();
		const diskMtimeChecked = new Set<string>();

		const loadCurrentContent = async (
			normPath: string,
		): Promise<string | null> => {
			if (virtualContents.has(normPath)) {
				return virtualContents.get(normPath) ?? null;
			}
			if (this.inspector.readNote) {
				const note = await this.inspector.readNote({ path: normPath });
				const content = note ? note.content : null;
				virtualContents.set(normPath, content);
				return content;
			}
			const exists = await this.inspector.fileExists(normPath);
			const content = exists ? '' : null;
			virtualContents.set(normPath, content);
			return content;
		};

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

			// 2. Duplicate create check
			if (op.type === 'create') {
				if (seenCreatedPaths.has(normPath)) {
					errors.push({
						operationIndex: i,
						path: normPath,
						code: 'operation_conflict',
						message: `Conflicting duplicate create operation for "${normPath}"`,
					});
					continue;
				}
				seenCreatedPaths.add(normPath);
			}

			// 3. Stale base / concurrent edit check (once per file before virtual mutation)
			if (
				op.type !== 'create' &&
				op.baseMtime !== undefined &&
				!diskMtimeChecked.has(normPath)
			) {
				diskMtimeChecked.add(normPath);
				const currentMtime =
					await this.inspector.getFileMtime(normPath);
				if (currentMtime !== null && currentMtime > op.baseMtime) {
					errors.push({
						operationIndex: i,
						path: normPath,
						code: 'stale_base',
						message: `File "${normPath}" was modified after it was read by the agent (stale base).`,
					});
				}
			}

			// 4. Validate against running virtual content state
			const currentContent = await loadCurrentContent(normPath);

			// If inspector does not support readNote (minimal mock), fall back to headingExists for patch-section
			if (
				!this.inspector.readNote &&
				op.type === 'patch-section' &&
				currentContent !== null
			) {
				const hasHeading = await this.inspector.headingExists(
					normPath,
					op.heading,
				);
				if (!hasHeading) {
					errors.push({
						operationIndex: i,
						path: normPath,
						code: 'heading_not_found',
						message: `Heading "${op.heading}" not found in note "${normPath}"`,
					});
				}
				continue;
			}

			const applied = applyOperationToContent(currentContent, op);
			if (!applied.ok) {
				errors.push({
					operationIndex: i,
					path: normPath,
					code: applied.code,
					message: applied.message,
				});
				continue;
			}

			virtualContents.set(normPath, applied.content);
		}

		return {
			valid: errors.length === 0,
			errors,
		};
	}
}
