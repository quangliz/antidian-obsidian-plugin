import type { MutationCall } from '../tools';
import type { ChangeOperation, ChangeSet, FileDiff, ValidationError } from '../types/changes';
import type { VaultService } from '../types/vault';
import type { ChangeSetApplicator } from './applicator';
import type { ChangeSetDiffGenerator } from './diff';
import type { ChangeStagingManager } from './index';
import type { ChangeSetValidator } from './validator';

/** What the user is asked to approve: exactly one staged operation. */
export interface ApprovalRequest {
	callId: string;
	toolName: string;
	operation: ChangeOperation;
	diff: FileDiff;
}

export type ApprovalDecision = 'approve' | 'reject';

export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;

export interface MutationReviewOptions {
	/** `auto` approves valid changes without asking; `ask` calls `requestApproval`. */
	mode: 'ask' | 'auto';
	requestApproval?: ApprovalHandler;
	/** Keep stale-base checks accurate after a file is changed mid-turn. */
	recordReadMtime?: (path: string, mtime: number) => void;
}

export interface MutationGateDeps {
	staging: ChangeStagingManager;
	validator: ChangeSetValidator;
	diffGenerator: ChangeSetDiffGenerator;
	applicator: ChangeSetApplicator;
	vault: Pick<VaultService, 'readNote'>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Reviews each staged mutation as soon as its tool call stages it: validate,
 * diff, get a decision, then apply it (so later reads see it) or discard it.
 * The model gets the outcome as the tool result and can adapt.
 */
export class MutationGate {
	private deps: MutationGateDeps;

	constructor(deps: MutationGateDeps) {
		this.deps = deps;
	}

	async review(call: MutationCall, opts: MutationReviewOptions): Promise<unknown> {
		const output = call.output;
		if (!isRecord(output) || output.staged !== true) return output;
		const changeSetId = output.changeSetId;
		const operationId = output.operationId;
		if (typeof changeSetId !== 'string' || typeof operationId !== 'string') {
			return output;
		}

		// No reviewer in ask mode: leave it staged for a later review.
		if (opts.mode === 'ask' && !opts.requestApproval) return output;

		// Take the op out of the turn's ChangeSet; it is decided on its own now.
		const operation = this.deps.staging.removeOperation(changeSetId, operationId);
		if (!operation) return output;

		const single: ChangeSet = {
			id: `${changeSetId}:${operationId}`,
			operations: [operation],
			createdAt: Date.now(),
			status: 'staged',
		};

		const validation = await this.deps.validator.validate(single);
		if (!validation.valid) {
			return {
				staged: false,
				applied: false,
				error: `Change is invalid and was discarded: ${formatErrors(validation.errors)}`,
			};
		}

		const diff = (await this.deps.diffGenerator.generate(single)).files[0];
		if (!diff) {
			return { staged: false, applied: false, error: 'Could not compute a diff for this change.' };
		}

		let decision: ApprovalDecision = 'approve';
		if (opts.mode === 'ask') {
			try {
				decision = await opts.requestApproval!({
					callId: call.callId,
					toolName: call.toolName,
					operation,
					diff,
				});
			} catch {
				decision = 'reject';
			}
		}

		if (decision === 'reject') {
			return {
				staged: false,
				applied: false,
				rejectedByUser: true,
				_diff: diff,
				message:
					'The user rejected this change; it was not applied. Do not retry the same edit unless asked — ask the user what they want instead.',
			};
		}

		try {
			await this.deps.applicator.apply(single);
		} catch (err) {
			return {
				staged: false,
				applied: false,
				_diff: diff,
				error: `Approved but failed to apply: ${err instanceof Error ? err.message : String(err)}`,
			};
		}

		// The file changed: refresh its read mtime so later edits aren't flagged stale.
		const after = await this.deps.vault.readNote({ path: operation.path }).catch(() => null);
		if (after?.mtime !== undefined) opts.recordReadMtime?.(operation.path, after.mtime);

		return {
			staged: false,
			applied: true,
			appliedChangeSetId: single.id,
			autoApproved: opts.mode === 'auto',
			_diff: diff,
			message:
				opts.mode === 'auto'
					? 'Change applied automatically (auto mode).'
					: 'The user approved this change and it has been applied to the vault.',
		};
	}
}

function formatErrors(errors: ValidationError[]): string {
	return errors.map((e) => `[${e.code}] ${e.message}`).join('; ');
}
