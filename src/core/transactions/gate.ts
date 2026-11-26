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
	/**
	 * Ask mode: receives the final output (applied / rejected / failed) once the
	 * user decides. `review` has already returned a pending output by then.
	 */
	onDecided?: (callId: string, output: unknown) => void;
}

/** A decided change the model has not been told about yet. */
export interface ReviewDecision {
	changeId: string;
	toolName: string;
	path: string;
	outcome: 'applied' | 'rejected' | 'failed';
	/** Why a change was approved but not applied. */
	detail?: string;
}

export interface MutationGateDeps {
	staging: ChangeStagingManager;
	validator: ChangeSetValidator;
	diffGenerator: ChangeSetDiffGenerator;
	applicator: ChangeSetApplicator;
	vault: Pick<VaultService, 'readNote' | 'normalizePath'>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

const PENDING_MESSAGE =
	"Shown to the user for approval; it is not in the vault yet. Don't retry it or edit this file again until it is decided. Continue with other work or finish your answer, saying the change awaits the user's approval. The decision is reported in a later tool result or with the user's next message.";

/**
 * Reviews each staged mutation as soon as its tool call stages it: validate,
 * diff, get a decision, then apply it (so later reads see it) or discard it.
 * Auto mode decides before the tool returns. Ask mode returns a pending output
 * at once (agy's MCP client times out after about a minute without a reply)
 * and reports the user's decision later through `takeReviewNotes`.
 */
export class MutationGate {
	private deps: MutationGateDeps;
	/** Normalized path → id of its change awaiting the user's decision. */
	private awaiting = new Map<string, string>();
	private decisions: ReviewDecision[] = [];

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

		const path = this.deps.vault.normalizePath(operation.path);
		if (this.awaiting.has(path)) {
			return {
				staged: false,
				applied: false,
				error: `"${path}" has an earlier change waiting for the user's decision; this change was discarded. Don't edit this file again until that change is decided.`,
			};
		}

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

		if (opts.mode === 'auto') return this.apply(single, diff, opts);

		// Ask mode: ask now, answer the tool call without waiting for the user.
		this.awaiting.set(path, single.id);
		void this.decide(call, single, path, diff, opts).then((output) =>
			opts.onDecided?.(call.callId, output),
		);
		return {
			staged: true,
			applied: false,
			pendingApproval: true,
			changeId: single.id,
			_diff: diff,
			message: PENDING_MESSAGE,
		};
	}

	/**
	 * Notes on decisions the model has not seen yet (each is reported once), plus,
	 * with `includeAwaiting`, the files whose changes still await the user.
	 */
	takeReviewNotes(options?: { includeAwaiting?: boolean }): string | undefined {
		const lines = this.decisions.splice(0).map(formatDecision);
		if (lines.length > 0) lines.unshift('Decisions on earlier changes:');
		if (options?.includeAwaiting && this.awaiting.size > 0) {
			const paths = [...this.awaiting.keys()].map((p) => `\`${p}\``).join(', ');
			lines.push(`Still waiting for the user's decision: ${paths}.`);
		}
		return lines.length > 0 ? lines.join('\n') : undefined;
	}

	/** Drops decisions not yet reported (the session they belong to has ended). */
	forgetDecisions(): void {
		this.decisions = [];
	}

	private async decide(
		call: MutationCall,
		single: ChangeSet,
		path: string,
		diff: FileDiff,
		opts: MutationReviewOptions,
	): Promise<unknown> {
		const record = (outcome: ReviewDecision['outcome'], detail?: string) =>
			this.decisions.push({ changeId: single.id, toolName: call.toolName, path, outcome, detail });
		try {
			let decision: ApprovalDecision;
			try {
				decision = await opts.requestApproval!({
					callId: call.callId,
					toolName: call.toolName,
					operation: single.operations[0]!,
					diff,
				});
			} catch {
				decision = 'reject';
			}

			if (decision === 'reject') {
				record('rejected');
				return {
					staged: false,
					applied: false,
					rejectedByUser: true,
					_diff: diff,
					message:
						'The user rejected this change; it was not applied. Do not retry the same edit unless asked — ask the user what they want instead.',
				};
			}

			// The note may have changed while the user was deciding.
			const validation = await this.deps.validator.validate(single);
			if (!validation.valid) {
				const detail = `the note changed before it was approved: ${formatErrors(validation.errors)}`;
				record('failed', detail);
				return { staged: false, applied: false, _diff: diff, error: `Approved but not applied: ${detail}` };
			}

			const output = await this.apply(single, diff, opts);
			if (isRecord(output) && output.applied === true) record('applied');
			else record('failed', isRecord(output) ? String(output.error) : undefined);
			return output;
		} finally {
			this.awaiting.delete(path);
		}
	}

	private async apply(
		single: ChangeSet,
		diff: FileDiff,
		opts: MutationReviewOptions,
	): Promise<Record<string, unknown>> {
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
		const { path } = single.operations[0]!;
		const after = await this.deps.vault.readNote({ path }).catch(() => null);
		if (after?.mtime !== undefined) opts.recordReadMtime?.(path, after.mtime);

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

function formatDecision(d: ReviewDecision): string {
	const what = `\`${d.toolName}\` on \`${d.path}\``;
	if (d.outcome === 'applied') return `- ${what}: approved and applied.`;
	if (d.outcome === 'rejected') {
		return `- ${what}: rejected by the user, not applied. Don't retry it unless asked.`;
	}
	return `- ${what}: approved but not applied (${d.detail ?? 'unknown error'}).`;
}

function formatErrors(errors: ValidationError[]): string {
	return errors.map((e) => `[${e.code}] ${e.message}`).join('; ');
}
